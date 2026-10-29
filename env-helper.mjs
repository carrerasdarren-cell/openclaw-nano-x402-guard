// Optional operator-owned signer adapter. Never paste secrets into a chat or a
// checked-in config. The operator runs the live payment; offline tests use mocks.
import { Helper } from '@x402nano/helper';

export function createHelper() {
  const key = process.env.NANO_ACCOUNT_PRIVATE_KEY;
  const rpc = process.env.NANO_RPC_URL;
  const work = process.env.NANO_WORK_GENERATION_URL;
  if (!/^[0-9a-fA-F]{64}$/.test(key ?? '') || !rpc || !work) {
    throw new Error('Operator must configure an account key, RPC and work endpoint');
  }
  for (const endpoint of [rpc, work]) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new Error('Use HTTPS RPC/work endpoints without URL credentials');
    }
  }
  return new Helper({
    NANO_ACCOUNT_PRIVATE_KEY: key,
    NANO_RPC_URL: rpc,
    NANO_WORK_GENERATION_URL: work,
  });
}
