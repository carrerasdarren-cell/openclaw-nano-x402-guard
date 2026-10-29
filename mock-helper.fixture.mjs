// Public synthetic block fixture. This file is never shipped in the package.
export function createHelper() {
  return { async generateSendBlock({payTo}) {
    return {type:'state',account:payTo,representative:payTo,previous:'A'.repeat(64),balance:'9',link:'0'.repeat(64),signature:'B'.repeat(128),work:'0'};
  }};
}
