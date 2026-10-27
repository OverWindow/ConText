import test from 'node:test';
import assert from 'node:assert/strict';
import {CreateBucketCommand} from '@aws-sdk/client-s3';
import {fixture} from './helpers.ts';
test('deployment readiness reaches PostgreSQL, private storage and the authenticated Python endpoint',{skip:!process.env.UNIFIED_TEST_PROCESSOR_URL},async()=>{
  const f=await fixture();
  try {
    await f.storage.client.send(new CreateBucketCommand({Bucket:f.config.bucket}));
    const response=await f.app.inject({url:'/ready'});
    assert.equal(response.statusCode,200,response.body);
    assert.deepEqual(response.json(),{status:'ok',protocol:2,checks:{database:'ok',storage:'ok',processor:'ok'}});
  } finally {await f.close();}
});
