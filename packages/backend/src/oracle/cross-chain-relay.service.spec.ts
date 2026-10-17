import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import {
  CrossChainOracleRelayService,
  Eip712Verifier,
  CrossChainAttestation,
} from './cross-chain-relay.service';

const typedData = {
  domain: { name: 'BACKitOracle', version: '1', chainId: 8453 },
  types: { Attestation: [{ name: 'callId', type: 'uint256' }] },
  primaryType: 'Attestation',
  message: { callId: 1 },
};

const baseAttestation: CrossChainAttestation = {
  chainId: 8453,
  contractAddress: '0x' + 'a'.repeat(40),
  signer: '0xABCDEF0000000000000000000000000000000001',
  signature: '0x' + 'ab'.repeat(65),
  typedData,
  finality: {
    blockNumber: 100,
    blockHash: '0x' + 'a'.repeat(64),
  },
  proof: '0xdeadbeef',
};

describe('CrossChainOracleRelayService', () => {
  let service: CrossChainOracleRelayService;
  let verifier: { recoverAddress: jest.Mock };
  let rpc: any;
  let config: any;

  beforeEach(() => {
    verifier = { recoverAddress: jest.fn() };
    rpc = {
      getAccount: jest.fn().mockResolvedValue({ accountId: 'GTEST' }),
      prepareTransaction: jest.fn().mockImplementation((tx) => tx),
      sendTransaction: jest.fn().mockResolvedValue({
        status: 'PENDING',
        hash: 'abc123',
        latestLedger: 42,
      }),
    };
    config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === 'CROSS_CHAIN_REQUIRED_CONFIRMATIONS') return 12;
        if (key === 'CROSS_CHAIN_MAX_FEE_STROOPS') return 1_000_000;
        if (key === 'CROSS_CHAIN_RELAY_CONTRACT_ID') return 'CABC';
        if (key === 'RELAY_SOURCE_ACCOUNT') return 'GTEST';
        return fallback;
      }),
    };

    service = new CrossChainOracleRelayService(
      rpc,
      config as unknown as ConfigService,
      verifier as unknown as Eip712Verifier,
    );
  });

  it('relays a valid, final attestation', async () => {
    verifier.recoverAddress.mockReturnValue(attestationSigner());

    const result = await service.relayAttestation(
      { ...baseAttestation, signer: attestationSigner() },
      100,
    );

    expect(rpc.sendTransaction).toHaveBeenCalledTimes(1);
    expect(result.transactionHash).toBe('abc123');
    expect(result.attestationSigner).toBe(attestationSigner());
  });

  it('rejects when the recovered signer does not match', async () => {
    verifier.recoverAddress.mockReturnValue('0x0000000000000000000000000000000000000000');

    await expect(
      service.relayAttestation(
        { ...baseAttestation, signer: attestationSigner() },
        100,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(rpc.sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects attestations that are not final', async () => {
    verifier.recoverAddress.mockReturnValue(attestationSigner());

    await expect(
      service.relayAttestation(
        { ...baseAttestation, signer: attestationSigner() },
        20, // only 9 confirmations for block 12+... wait blockNumber 8
      ),
    ).rejects.toThrow(/not final/);
  });

  it('validates required payload fields', async () => {
    await expect(
      service.relayAttestation(
        { ...baseAttestation, proof: '' },
        100,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('re-prices the transaction when fees surge', async () => {
    verifier.recoverAddress.mockReturnValue(attestationSigner());
    rpc.sendTransaction
      .mockRejectedValueOnce(new Error('txInsufficientFee'))
      .mockResolvedValueOnce({ status: 'PENDING', hash: 'def456', latestLedger: 43 });

    const result = await service.relayAttestation(
      { ...baseAttestation, signer: attestationSigner() },
      100,
    );

    expect(rpc.sendTransaction).toHaveBeenCalledTimes(2);
    expect(result.transactionHash).toBe('def456');
  });

  it('assertFinality accepts a block with exactly the required confirmations', () => {
    expect(() =>
      service.assertFinality(
        { ...baseAttestation, signer: attestationSigner() },
        23, // 23 - 12 + 1 = 12 confirmations
      ),
    ).not.toThrow();
  });
});

function attestationSigner(): string {
  return '0xAbC0000000000000000000000000000000000001';
}
