import test from 'node:test';
import assert from 'node:assert/strict';
import { createNanoPaymentPayload, createOperatorPaymentFactory } from './nano-client.mjs';
import { Helper } from '@x402nano/helper';
import { deriveAccountFromPrivateKey, hashBlock, verifyBlock } from 'nano-sdk/crypto';
import { createSendBlock } from 'nano-sdk/blocks';

const required = () => ({ x402Version: 2, resource: { url: 'https://seller.example/v1/hash' }, accepts: [{scheme:'exact',network:'nano:mainnet',asset:'XNO',payTo:'nano_synthetic_receiver',amount:'1000',maxTimeoutSeconds:60,extra:{workOptional:true}}] });
const block = () => ({type:'state',account:'nano_synthetic_payer',previous:'A'.repeat(64),representative:'nano_synthetic_rep',balance:'1000',link:'B'.repeat(64),signature:'C'.repeat(128),work:'0'});

test('wraps the real pinned ExactNanoScheme and preserves the exact guard-approved requirement', async () => {
  const calls=[]; const r=required();
  const pay=createNanoPaymentPayload({helper:{async generateSendBlock(p){calls.push(p);return block();}}});
  const result=await pay(r);
  assert.deepEqual(calls,[{payTo:r.accepts[0].payTo,amount:'1000'}]);
  assert.deepEqual(result,{x402Version:2,resource:r.resource,accepted:r.accepts[0],payload:{block:block()}});
});
test('required work is retained; a missing/zero work block is refused',async()=>{
  const r=required();r.accepts[0].extra.workOptional=false;
  await assert.rejects(createNanoPaymentPayload({helper:{async generateSendBlock(){return block();}}})(r),/missing work/);
  const b=block();b.work='1234567890abcdef';
  const p=await createNanoPaymentPayload({helper:{async generateSendBlock(){return b;}}})(r);
  assert.equal(p.payload.block.work,b.work);
});
test('signer exceptions cannot expose secrets and cause no retries',async()=>{
  let n=0;const pay=createNanoPaymentPayload({helper:{async generateSendBlock(){n++;throw new Error('SECRET_EXAMPLE_NOT_A_KEY');}}});
  await assert.rejects(pay(required()),e=>!String(e).includes('SECRET_EXAMPLE_NOT_A_KEY'));
  assert.equal(n,1);
});
test('invalid block and unsupported requirement are refused',async()=>{
  const pay=createNanoPaymentPayload({helper:{async generateSendBlock(){return {...block(),signature:'bad'};}}});
  await assert.rejects(pay(required()),/invalid block/);
  const r=required();r.accepts[0].network='nano:betanet';await assert.rejects(pay(r),/Unsupported/);
});
test('operator module is not imported during construction and errors are sanitized',async()=>{
  assert.throws(()=>createOperatorPaymentFactory({signerModule:'relative.mjs'}),/absolute/);
  const pay=createOperatorPaymentFactory({signerModule:'/nonexistent/operator-helper.mjs'});
  await assert.rejects(pay(required()),/Operator payment helper failed/);
});

test('official helper refuses invalid proof of work with synthetic state and mocked RPC',async()=>{
  // Public synthetic test material, never a funded/user account. All fetches are
  // replaced and every action except account_info/block_info is refused.
  const key='0'.repeat(64);
  const account=deriveAccountFromPrivateKey({privateKey:key});
  const destination='nano_1111111111111111111111111111111111111111111111111111hifc8npp';
  const frontier={type:'state',account,previous:'0'.repeat(64),representative:destination,balance:'5000',link:'0'.repeat(64),link_as_account:destination,signature:'0'.repeat(128),work:'0'.repeat(16)};
  const frontierHash=hashBlock({block:frontier});
  const calls=[];const savedFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    assert.equal(url,'https://synthetic-rpc.invalid');
    const body=JSON.parse(options.body);calls.push(body.action);
    if(body.action==='account_info')return new Response(JSON.stringify({frontier:frontierHash,balance:'5000',representative:destination}));
    if(body.action==='block_info')return new Response(JSON.stringify({contents:frontier}));
    throw new Error('A synthetic test attempted an unexpected RPC action');
  };
  try{
    const helper=new Helper({NANO_ACCOUNT_PRIVATE_KEY:key,NANO_RPC_URL:'https://synthetic-rpc.invalid',NANO_WORK_GENERATION_URL:'https://synthetic-rpc.invalid'});
    helper.setCustomWorkGenerator(async()=> '0'.repeat(16));
    const r=required();r.accepts[0].payTo=destination;
    await assert.rejects(createNanoPaymentPayload({helper})(r),/Nano block creation failed/);
    assert.deepEqual(calls,['account_info','block_info']);
  }finally{globalThis.fetch=savedFetch;}
});

test('actual Nano SDK signing through the injected helper preserves amount, destination and valid signature offline',async()=>{
  const key='0'.repeat(64); // Public synthetic material, no real wallet.
  const account=deriveAccountFromPrivateKey({privateKey:key});
  const destination='nano_1111111111111111111111111111111111111111111111111111hifc8npp';
  const frontier={type:'state',account,previous:'0'.repeat(64),representative:destination,balance:'5000',link:'0'.repeat(64),link_as_account:destination,signature:'0'.repeat(128),work:'0'.repeat(16)};
  const r=required();r.accepts[0].payTo=destination;
  const helper={async generateSendBlock(p){return createSendBlock({amount:p.amount,destination:p.payTo,frontierBlock:frontier,privateKey:key});}};
  const payload=await createNanoPaymentPayload({helper})(r);const b=payload.payload.block;
  assert.equal(b.balance,'4000');assert.equal(b.link_as_account,destination);
  assert.equal(b.previous,hashBlock({block:frontier}));assert.equal(b.account,account);
  assert.equal(verifyBlock({block:b}),true);
  assert.equal(payload.accepted.amount,'1000');
  // Work is intentionally the optional placeholder, not a claimed valid PoW.
  assert.equal(b.work,'0'.repeat(16));
});
