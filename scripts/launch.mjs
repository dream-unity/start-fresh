import { spawn } from 'node:child_process';
import { createAppServer } from '../server.mjs';

// A local launcher only: it neither installs software nor obtains credentials.
const port=Number(process.env.PORT||4173);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT must be between 1 and 65535.');
const server=createAppServer();
server.on('error',error=>{
  console.error(error.code==='EADDRINUSE'
    ? `Port ${port} is already in use. If Dream Unity is already running, open http://127.0.0.1:${port}.`
    : `Dream Unity could not start: ${error.message}`);
  process.exitCode=1;
});
server.listen(port,'127.0.0.1',()=>{
  const url=`http://127.0.0.1:${port}`;
  console.log(`Dream Unity is ready at ${url}\nKeep this window open while using the Nexus. Press Ctrl+C to stop.`);
  const command=process.platform==='darwin'?['open',[url]]
    :process.platform==='win32'?['rundll32',['url.dll,FileProtocolHandler',url]]
    :['xdg-open',[url]];
  const opener=spawn(command[0],command[1],{stdio:'ignore',windowsHide:true});
  opener.on('error',()=>console.log(`Open ${url} in your browser to begin.`));
  opener.unref();
});
let closing=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
  if(closing)return;closing=true;server.abortActiveRequests();server.close();
  const timer=setTimeout(()=>server.closeAllConnections(),2000);timer.unref();
});
