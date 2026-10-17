import {
  Injectable,
  Logger,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SorobanRpc, Contract, nativeToScVal, xdr } from '@stellar/stellar-sdk';

/**
 * EIP-712 typed-data envelope relayed from a source chain (Base / Ethereum).
 */
export interface Eip712TypedData {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * A verified price attestation (or resolution proof) observed on the source
 * chain that should be relayed to the Soroban `cross_chain_oracle_relay`
 * contract.
 */
export interface CrossChainAttestation {
  /** EVM chain id of the source chain (e.g. 8453 for Base, 1 for Ethereum). */
  chainId: number;
  /** Address of the emitting oracle contract on the source chain. */
  contractAddress: string;
  /** Address that produced the EIP-712 signature. */
  signer: string;
  /** 65-byte EIP-712 signature (0x-prefixed hex). */
  signature: string;
  /** EIP-712 typed data that was signed. */
  typedData: Eip712TypedData;
  /** Source-chain finality metadata used before relaying. */
  finality: {
    blockNumber: number;
    blockHash: string;
  };
  /** Opaque payload relayed verbatim to Soroban as proof bytes. */
  proof: string;
}

export interface RelayResult {
  attestationSigner: string;
  transactionHash: string;
  ledger: number;
  feeStroops: string;
}

/**
 * Recovers the signer address from an EIP-712 signature.
 *
 * Implemented as a separate provider so it can be swapped/mocked in tests and
 * so that the `ethers` dependency is only required at runtime (kept out of the
 * static import graph — see package.json).
 */
@Injectable()
export class Eip712Verifier {
  private readonly logger = new Logger(Eip712Verifier.name);

  recoverAddress(typedData: Eip712TypedData, signature: string): string {
    let ethers: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ethers = require('ethers');
    } catch {
      throw new ServiceUnavailableException(
        'EIP-712 verification is unavailable: ethers dependency is not installed',
      );
    }

    try {
      return ethers.verifyTypedData(
        typedData.domain,
        typedData.types,
        typedData.message,
        signature,
      );
    } catch (err) {
      this.logger.warn(`EIP-712 recovery failed: ${(err as Error).message}`);
      throw new BadRequestException('Malformed EIP-712 signature');
    }
  }
}

@Injectable()
export class CrossChainOracleRelayService {
  private readonly logger = new Logger(CrossChainOracleRelayService.name);

  /** Minimum source-chain confirmations before a proof is considered final. */
  private readonly requiredConfirmations: number;
  /** Maximum fee (in stroops) we are willing to pay per relayed attestation. */
  private readonly maxFeeStroops: number;
  /** Number of times to re-price the transaction when fees surge. */
  private readonly maxFeeRetries = 3;

  constructor(
    private readonly rpc: SorobanRpc.Server,
    private readonly config: ConfigService,
    private readonly verifier: Eip712Verifier,
  ) {
    this.requiredConfirmations = Number(
      this.config.get('CROSS_CHAIN_REQUIRED_CONFIRMATIONS', 12),
    );
    this.maxFeeStroops = Number(
      this.config.get('CROSS_CHAIN_MAX_FEE_STROOPS', 1_000_000),
    );
  }

  /**
   * Validate the attestation signature and source-chain finality, then relay
   * the proof to the Soroban `cross_chain_oracle_relay` contract.
   */
  async relayAttestation(
    attestation: CrossChainAttestation,
    sourceBlockNumber: number,
  ): Promise<RelayResult> {
    this.validatePayload(attestation);

    const recovered = this.verifier.recoverAddress(
      attestation.typedData,
      attestation.signature,
    );
    if (recovered.toLowerCase() !== attestation.signer.toLowerCase()) {
      throw new BadRequestException(
        'Attestation signature does not match the declared signer',
      );
    }

    this.assertFinality(attestation, sourceBlockNumber);

    return this.submitToSoroban(attestation);
  }

  /**
   * Reject attestations whose source block has not accumulated enough
   * confirmations, or whose block hash is self-inconsistent.
   */
  assertFinality(
    attestation: CrossChainAttestation,
    sourceBlockNumber: number,
  ): void {
    const { blockNumber, blockHash } = attestation.finality;
    if (!blockNumber || blockNumber <= 0) {
      throw new BadRequestException('Attestation is missing a source block');
    }
    if (!blockHash || !/^0x[0-9a-fA-F]{64}$/.test(blockHash)) {
      throw new BadRequestException('Attestation has an invalid block hash');
    }
    const confirmations = sourceBlockNumber - blockNumber + 1;
    if (confirmations < this.requiredConfirmations) {
      throw new BadRequestException(
        `Attestation not final: ${confirmations}/${this.requiredConfirmations} confirmations`,
      );
    }
  }

  private validatePayload(attestation: Partial<CrossChainAttestation>): void {
    if (!attestation) {
      throw new BadRequestException('Attestation payload is required');
    }
    if (!Number.isInteger(attestation.chainId) || attestation.chainId <= 0) {
      throw new BadRequestException('Invalid source chain id');
    }
    if (!attestation.contractAddress?.startsWith('0x')) {
      throw new BadRequestException('Invalid source contract address');
    }
    if (!attestation.signer?.startsWith('0x')) {
      throw new BadRequestException('Invalid attestation signer');
    }
    if (!attestation.signature?.startsWith('0x')) {
      throw new BadRequestException('Invalid attestation signature');
    }
    if (!attestation.proof) {
      throw new BadRequestException('Attestation proof payload is required');
    }
  }

  /**
   * Build and submit the Soroban transaction that carries the proof bytes.
   *
   * The transaction is re-priced (up to {@link maxFeeRetries}) while the
   * network base fee fluctuates, guarding against `txInsufficientFee`.
   */
  private async submitToSoroban(
    attestation: CrossChainAttestation,
  ): Promise<RelayResult> {
    const contractId = this.config.get<string>(
      'CROSS_CHAIN_RELAY_CONTRACT_ID',
    );
    if (!contractId) {
      throw new ServiceUnavailableException(
        'CROSS_CHAIN_RELAY_CONTRACT_ID is not configured',
      );
    }

    const proofBytes = Buffer.from(
      attestation.proof.replace(/^0x/, ''),
      'hex',
    );
    const proofScVal = xdr.ScVal.scvBytes(proofBytes);
    const chainIdScVal = nativeToScVal(attestation.chainId, { type: 'u32' });
    const signerScVal = nativeToScVal(attestation.signer, { type: 'string' });
    const blockHashScVal = nativeToScVal(attestation.finality.blockHash, {
      type: 'string',
    });

    const contract = new Contract(contractId);
    const operation = contract.call(
      'relay_attestation',
      chainIdScVal,
      signerScVal,
      blockHashScVal,
      proofScVal,
    );

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxFeeRetries; attempt++) {
      try {
        const account = await this.rpc.getAccount(
          this.config.get<string>('RELAY_SOURCE_ACCOUNT') ?? '',
        );
        const fee = String(
          Math.min(this.maxFeeStroops, 100 * Math.pow(2, attempt)),
        );
        const tx = this.buildTransaction(account, operation, fee);
        const prepared: any = await this.rpc.prepareTransaction(tx);
        const response: any = await this.rpc.sendTransaction(prepared);

        if (response?.status === 'ERROR') {
          throw new ServiceUnavailableException(
            `Soroban rejected relay transaction: ${JSON.stringify(
              response.errorResult ?? response.status,
            )}`,
          );
        }

        return {
          attestationSigner: attestation.signer,
          transactionHash: response?.hash ?? prepared?.hash ?? '',
          ledger: Number(response?.latestLedger ?? 0),
          feeStroops: fee,
        };
      } catch (err) {
        lastError = err;
        this.logger.warn(
          `Relay attempt ${attempt + 1} failed: ${
            (err as Error).message
          } — re-pricing`,
        );
      }
    }

    throw new ServiceUnavailableException(
      `Cross-chain relay failed after ${this.maxFeeRetries + 1} attempts: ${
        (lastError as Error)?.message
      }`,
    );
  }

  /**
   * Isolated so the Stellar SDK transaction builder can be stubbed in tests.
   */
  protected buildTransaction(account: unknown, operation: any, fee: string): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { TransactionBuilder, Networks } = require('@stellar/stellar-sdk');
    return new TransactionBuilder(account as any, {
      fee,
      networkPassphrase:
        this.config.get<string>('STELLAR_NETWORK_PASSPHRASE') ??
        Networks.TESTNET,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();
  }
}
