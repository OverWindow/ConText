/** Loopback-only synthetic account/DB harness for native and browser integration. */
import {fixture} from './helpers.ts';
import {CreateBucketCommand} from '@aws-sdk/client-s3';
const f=await fixture({live:true});
f.config.corsOrigins.push('http://localhost:3100');
await f.storage.client.send(new CreateBucketCommand({Bucket:f.config.bucket}));
await f.app.listen({host:'127.0.0.1',port:Number(process.env.UNIFIED_FIXTURE_PORT||18003)});
if(process.env.UNIFIED_TEST_PROCESSOR_URL)f.processing.start();
process.stdout.write(`Unified test fixture ready at ${f.app.listeningOrigin}\n`);
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{if(stopping)return;stopping=true;void f.close().then(()=>process.exit(0));});
