import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestPluginApi } from 'openclaw/plugin-sdk/plugin-test-api';
import { createSendBlock } from 'nano-sdk/blocks';
import { deriveAccountFromPrivateKey, signBlock, hashBlock } from 'nano-sdk/crypto';
import { createManualNaultHelper } from './manual-nault-helper.mjs';
import { createNanoPaymentPayload } from './nano-client.mjs';
import { createPlugin } from './index.mjs';

test('native OpenClaw tool, guard and official Nano scheme use a checked manual signature end to end offline',async()=>{
  const key='0'.repeat(64); // Public synthetic material, not a user wallet.
  const account=deriveAccountFromPrivateKey({privateKey:key});
  const destination='nano_1111111111111111111111111111111111111111111111111111hifc8npp';
  const previous={type:'state',account,previous:'0'.repeat(64),representative:destination,balance:'5000',link:'0'.repeat(64),link_as_account:destination,signature:'0'.repeat(128),work:'0'.repeat(16)};
  previous.signature=signBlock({block:previous,privateKey:key});
  let manualPrompts=0,paidRequests=0;
  const helper=createManualNaultHelper({previousBlock:previous,async requestSignature({unsignedURI,proposal}){
    manualPrompts++;assert.equal(unsignedURI.startsWith('nanosign:'),true);
    const packet=JSON.parse(unsignedURI.slice(9));assert.deepEqual(packet.block,proposal);
    const signed=createSendBlock({amount:'1000',destination,frontierBlock:previous,privateKey:key});
    delete signed.type; delete signed.work; // Actual Nault output omits these metadata fields.
    return 'nanoprocess:'+JSON.stringify({block:signed,previous});
  }});
  const url='https://merchant.example/v1/hash';
  const required={x402Version:2,resource:{url},accepts:[{scheme:'exact',network:'nano:mainnet',asset:'XNO',payTo:destination,amount:'1000',maxTimeoutSeconds:60,extra:{work:'optional',workOptional:true,workThreshold:'fffffff800000000',session:'1'.repeat(32)}}]};
  const fetchImpl=async(actual,options)=>{
    assert.equal(actual,url);assert.equal(options.redirect,'manual');
    const header=new Headers(options.headers).get('payment-signature');
    if(!header)return new Response(JSON.stringify({x402:required}),{status:402});
    paidRequests++;const signed=JSON.parse(Buffer.from(header,'base64').toString());
    assert.deepEqual(signed.accepted,required.accepts[0]);
    assert.equal(signed.payload.block.balance,'4000');
    assert.equal(signed.payload.block.previous,hashBlock({block:previous}));
    assert.equal(signed.payload.block.link,'0'.repeat(64));
    return new Response(JSON.stringify({hash:'mock-resource-result'}),{status:200});
  };
  let tool;
  const entry=createPlugin({fetchImpl,createPaymentPayload:createNanoPaymentPayload({helper})});
  entry.register(createTestPluginApi({pluginConfig:{allowPayTo:[destination],allowedOrigins:['https://merchant.example'],maxPerCallRaw:'1000',maxTotalRaw:'1000',signerModule:'/operator/manual-helper.mjs'},registerTool:t=>{tool=t;}}));
  const response=await tool.execute('native-manual-test',{requestId:'one-manual-purchase',url,method:'POST',body:'hello'});
  const result=JSON.parse(response.content.find(x=>x.type==='text').text);
  assert.equal(result.result.status,200);assert.equal(manualPrompts,1);assert.equal(paidRequests,1);
});
