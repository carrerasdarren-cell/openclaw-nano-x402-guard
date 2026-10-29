import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createManualNaultHelper } from './manual-nault-helper.mjs';
import { readSignedNaultURI } from './manual-nault-tty.mjs';

// This is an OPERATOR-RUN interactive adapter, not a browser controller. It never
// reads a seed/private key, automates Nault, or broadcasts a block. The enclosing
// live purchase sends the signed payment, so the operator must run that purchase.
export async function createHelper() {
  const file = process.env.NANO_PUBLIC_FRONTIER_FILE;
  if (!file || !isAbsolute(file) || !process.stdin.isTTY) {
    throw new Error('A public frontier file and an operator terminal are required');
  }
  let previousBlock;
  try {
    const bytes = await readFile(file);
    if (bytes.length > 16_384) throw new Error('Oversize frontier');
    previousBlock = JSON.parse(bytes.toString('utf8'));
  } catch { throw new Error('Cannot read the public state-block file'); }
  return createManualNaultHelper({
    previousBlock,
    async requestSignature({ unsignedURI }) {
      try {
        process.stderr.write('\nOperator action: import this UNSIGNED request into Nault remote signing.\n');
        process.stderr.write('Review the exact sender, recipient and amount, then personally sign.\n');
        process.stderr.write('Copy the nanoprocess: response here; do not broadcast it in Nault.\n');
        process.stderr.write('Keep it out of chat/logs. The enclosing purchase will send the payment.\n');
        process.stderr.write('The quote expires after its published timeout; a late response is refused.\n\n');
        process.stderr.write(unsignedURI + '\n\n');
        process.stderr.write('Paste signed nanoprocess: response, then Enter. Input is hidden.\n');
        process.stderr.write('Ctrl-C cancels. Input expires in 55 seconds.\n');
        return await readSignedNaultURI({ input: process.stdin, timeoutMs: 55_000 });
      } finally { process.stderr.write('\n'); }
    },
  });
}
