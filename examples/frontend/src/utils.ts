import { SealClient, SessionKey, NoAccessError, EncryptedObject } from '@mysten/seal';
import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import React from 'react';

export type MoveCallConstructor = (tx: Transaction, id: string) => void;

export type DecryptedFile = {
  url: string;
  name: string;
  type: string;
};

// Plaintext layout: MAGIC | u32 BE header length | JSON { name, type } | file bytes.
// Blobs without MAGIC were uploaded before metadata was added and are treated as images.
const FILE_MAGIC = new TextEncoder().encode('SEALF1');
const LEGACY_FILE_TYPE = 'image/jpg';

export const packFile = (bytes: Uint8Array, name: string, type: string): Uint8Array => {
  const header = new TextEncoder().encode(JSON.stringify({ name, type }));
  const packed = new Uint8Array(FILE_MAGIC.length + 4 + header.length + bytes.length);
  packed.set(FILE_MAGIC, 0);
  new DataView(packed.buffer).setUint32(FILE_MAGIC.length, header.length);
  packed.set(header, FILE_MAGIC.length + 4);
  packed.set(bytes, FILE_MAGIC.length + 4 + header.length);
  return packed;
};

export const unpackFile = (
  data: Uint8Array,
): { bytes: Uint8Array; name: string | null; type: string } => {
  const legacy = { bytes: data, name: null, type: LEGACY_FILE_TYPE };
  const headerStart = FILE_MAGIC.length + 4;
  if (data.length < headerStart || !FILE_MAGIC.every((b, i) => data[i] === b)) {
    return legacy;
  }
  const headerLength = new DataView(data.buffer, data.byteOffset).getUint32(FILE_MAGIC.length);
  if (headerStart + headerLength > data.length) {
    return legacy;
  }
  try {
    const header = JSON.parse(
      new TextDecoder().decode(data.subarray(headerStart, headerStart + headerLength)),
    );
    return {
      bytes: data.subarray(headerStart + headerLength),
      name: typeof header.name === 'string' && header.name ? header.name : null,
      type:
        typeof header.type === 'string' && header.type ? header.type : 'application/octet-stream',
    };
  } catch {
    return legacy;
  }
};

export const downloadAndDecrypt = async (
  blobIds: string[],
  sessionKey: SessionKey,
  suiClient: SuiClient,
  sealClient: SealClient,
  moveCallConstructor: (tx: Transaction, id: string) => void,
  setError: (error: string | null) => void,
  setDecryptedFiles: (files: DecryptedFile[]) => void,
  setIsDialogOpen: (open: boolean) => void,
  setReloadKey: (updater: (prev: number) => number) => void,
) => {
  const aggregators = ['aggregator1', 'aggregator2', 'aggregator3', 'aggregator4', 'aggregator5', 'aggregator6'];
  // First, download all files in parallel (ignore errors)
  const downloadResults = await Promise.all(
    blobIds.map(async (blobId) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const randomAggregator = aggregators[Math.floor(Math.random() * aggregators.length)];
        const aggregatorUrl = `/${randomAggregator}/v1/blobs/${blobId}`;
        const response = await fetch(aggregatorUrl, { signal: controller.signal });
        clearTimeout(timeout);
        if (!response.ok) {
          return null;
        }
        return await response.arrayBuffer();
      } catch (err) {
        console.error(`Blob ${blobId} cannot be retrieved from Walrus`, err);
        return null;
      }
    }),
  );

  // Filter out failed downloads
  const validDownloads = downloadResults.filter((result): result is ArrayBuffer => result !== null);
  console.log('validDownloads count', validDownloads.length);

  if (validDownloads.length === 0) {
    const errorMsg =
      'Cannot retrieve files from this Walrus aggregator, try again (a randomly selected aggregator will be used). Files uploaded more than 1 epoch ago have been deleted from Walrus.';
    console.error(errorMsg);
    setError(errorMsg);
    return;
  }

  // Fetch keys in batches of <=10
  for (let i = 0; i < validDownloads.length; i += 10) {
    const batch = validDownloads.slice(i, i + 10);
    const ids = batch.map((enc) => EncryptedObject.parse(new Uint8Array(enc)).id);
    const tx = new Transaction();
    ids.forEach((id) => moveCallConstructor(tx, id));
    const txBytes = await tx.build({ client: suiClient, onlyTransactionKind: true });
    try {
      await sealClient.fetchKeys({ ids, txBytes, sessionKey, threshold: 2 });
    } catch (err) {
      console.log(err);
      const errorMsg =
        err instanceof NoAccessError
          ? 'No access to decryption keys'
          : 'Unable to decrypt files, try again';
      console.error(errorMsg, err);
      setError(errorMsg);
      return;
    }
  }

  // Then, decrypt files sequentially
  const decryptedFiles: DecryptedFile[] = [];
  for (const encryptedData of validDownloads) {
    const fullId = EncryptedObject.parse(new Uint8Array(encryptedData)).id;
    const tx = new Transaction();
    moveCallConstructor(tx, fullId);
    const txBytes = await tx.build({ client: suiClient, onlyTransactionKind: true });
    try {
      // Note that all keys are fetched above, so this only local decryption is done
      const decryptedFile = await sealClient.decrypt({
        data: new Uint8Array(encryptedData),
        sessionKey,
        txBytes,
      });
      const { bytes, name, type } = unpackFile(decryptedFile);
      decryptedFiles.push({
        url: URL.createObjectURL(new Blob([bytes], { type })),
        name: name ?? `file-${decryptedFiles.length + 1}`,
        type,
      });
    } catch (err) {
      console.log(err);
      const errorMsg =
        err instanceof NoAccessError
          ? 'No access to decryption keys'
          : 'Unable to decrypt files, try again';
      console.error(errorMsg, err);
      setError(errorMsg);
      return;
    }
  }

  if (decryptedFiles.length > 0) {
    setDecryptedFiles(decryptedFiles);
    setIsDialogOpen(true);
    setReloadKey((prev) => prev + 1);
  }
};

export const getObjectExplorerLink = (id: string): React.ReactElement => {
  return React.createElement(
    'a',
    {
      href: `https://testnet.suivision.xyz/object/${id}`,
      target: '_blank',
      rel: 'noopener noreferrer',
      style: { textDecoration: 'underline' },
    },
    id.slice(0, 10) + '...',
  );
};
