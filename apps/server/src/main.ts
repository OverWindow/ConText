import { configFromEnv } from './config.ts';
import { createServer } from './app.ts';
const config=configFromEnv();
const {app}=await createServer(config,{worker:true,logger:true});
await app.listen({port:config.port,host:config.host});
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{void app.close();});
