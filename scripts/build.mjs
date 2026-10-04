import {cp,mkdir,rm,writeFile,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
await rm('dist',{recursive:true,force:true}); await mkdir('dist',{recursive:true});
for(const path of ['index.html','style.css','src','vendor']) await cp(path,`dist/${path}`,{recursive:true});
let revision=process.env.GITHUB_SHA || 'local';
if(revision==='local') {try {revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();} catch {}}
await writeFile('dist/release.json',JSON.stringify({name:'start-fresh',revision,builtAt:new Date().toISOString()})+'\n');
await writeFile('dist/.nojekyll','');
for(const path of ['src/app.js','src/meaning.js','src/model.js','src/response-schema.js','src/voice.js','src/memory.js','src/scene.js']) {
  execFileSync(process.execPath,['--check',path]);
}
console.log(`Built independent static experience (${revision}).`);
