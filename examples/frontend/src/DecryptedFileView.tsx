// Copyright (c), Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0
import { Link, Text } from '@radix-ui/themes';
import { DecryptedFile } from './utils';

export function DecryptedFileView({ file }: { file: DecryptedFile }) {
  const download = (
    <Link href={file.url} download={file.name}>
      Download {file.name}
    </Link>
  );
  if (file.type.startsWith('image/')) {
    return (
      <div>
        <img src={file.url} alt={file.name} />
        {download}
      </div>
    );
  }
  if (file.type.startsWith('video/')) {
    return (
      <div>
        <video src={file.url} controls style={{ maxWidth: '100%' }} />
        {download}
      </div>
    );
  }
  if (file.type.startsWith('audio/')) {
    return (
      <div>
        <audio src={file.url} controls style={{ width: '100%' }} />
        {download}
      </div>
    );
  }
  return (
    <div>
      <Text as="p" size="2" color="gray">
        {file.type}
      </Text>
      {download}
    </div>
  );
}
