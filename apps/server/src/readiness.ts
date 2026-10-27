type Dependency = 'database' | 'storage' | 'processor';
type Result = {status:'ok'|'unavailable';protocol:2;checks:Record<Dependency,'ok'|'unavailable'>};
/** Bound dependency probes and share cached results across concurrent health checks. */
export class Readiness {
  private cached?: {until:number;result:Result};
  private pending?: Promise<Result>;
  constructor(private probes:Record<Dependency,()=>Promise<void>>,private ttl=10000,private timeout=6000) {}
  async check():Promise<Result> {
    if (this.cached && this.cached.until > Date.now()) return this.cached.result;
    if (this.pending) return this.pending;
    this.pending = this.probe();
    try { return await this.pending; } finally { this.pending = undefined; }
  }
  private async probe():Promise<Result> {
    const names = Object.keys(this.probes) as Dependency[];
    const values = await Promise.allSettled(names.map(name=>new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Dependency probe timed out')),this.timeout);
      Promise.resolve().then(this.probes[name]).then(()=>{clearTimeout(timer);resolve();},()=>{clearTimeout(timer);reject(new Error('Dependency is unavailable'));});
    })));
    const checks = Object.fromEntries(names.map((name,index)=>[name,values[index].status === 'fulfilled' ? 'ok' : 'unavailable'])) as Result['checks'];
    const result:Result = {status:values.every(value=>value.status === 'fulfilled') ? 'ok' : 'unavailable',protocol:2,checks};
    this.cached = {until:Date.now()+this.ttl,result};
    return result;
  }
}
