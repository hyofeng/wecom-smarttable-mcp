import assert from 'node:assert/strict';
import { dataDir } from '../dist/local.js';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
process.umask(0o077);
if(!process.argv[2]) throw new Error('Usage: node scripts/verify-errors.mjs <private-target.json>');
const {url}=JSON.parse(await readFile(process.argv[2],'utf8'));
const results=[];
async function connect(dir){
 const client=new Client({name:'wecom-error-verifier',version:'0.1.0'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('dist/server.js')],
  env:{WECOM_MCP_DATA_DIR:dir||dataDir}}));
 return client;
}
async function expectError(c,name,args,code){
 const r=await c.callTool({name,arguments:args});
 assert.equal(r.isError,true);assert.equal(r.structuredContent.error.code,code);
 results.push(code);
}
const c=await connect();
try{
 await expectError(c,'wecom_table_structure',{url:'https://doc.weixin.qq.com/sheet/x'},'UNSUPPORTED_TYPE');
 await expectError(c,'wecom_table_structure',{url:'https://doc.weixin.qq.com.evil.example/smartsheet/x'},'INVALID_URL');
 const s=await c.callTool({name:'wecom_table_structure',arguments:{url}});assert.ok(!s.isError);
 const table=s.structuredContent.sheets.find(t=>t.fields.some(f=>f.type_code===5));assert.ok(table);
 await expectError(c,'wecom_read_records',{url,sheet_id:table.id,fields:['__missing_field__'],page_size:1},'UNKNOWN_FIELD');
 await expectError(c,'wecom_read_records',{url,sheet_id:table.id,cursor:Buffer.from('{}').toString('base64url')},'INVALID_CURSOR');
 const p=await c.callTool({name:'wecom_read_records',arguments:{url,sheet_id:table.id,page_size:31}});assert.ok(!p.isError);
 const old=JSON.parse(Buffer.from(p.structuredContent.next_cursor,'base64url').toString());old.revision--;
 await expectError(c,'wecom_read_records',{url,sheet_id:table.id,cursor:Buffer.from(JSON.stringify(old)).toString('base64url')},'STALE_CURSOR');
 const image=p.structuredContent.records.flatMap(r=>Object.values(r.fields).flatMap(f=>f.assets||[])).find(a=>a.kind==='image');assert.ok(image);
 await expectError(c,'wecom_download_asset',{url,locator:{...image.locator,asset_id:'__missing_asset__'}},'ASSET_NOT_FOUND');
 await expectError(c,'wecom_download_asset',{url,locator:{...image.locator,record_id:'__missing_record__'}},'STALE_ASSET_LOCATOR');
}finally{await c.close();}
const dir=await mkdtemp(join(tmpdir(),'wecom-session-check-'));
try{
 let c=await connect(dir);try{await expectError(c,'wecom_table_structure',{url},'LOGIN_REQUIRED');}finally{await c.close();}
 // 空 Cookie 表示真实的未登录客户端，仍请求真实企微接口，未替换任何响应。
 await writeFile(join(dir,'state.json'),JSON.stringify({cookies:[],origins:[]}),{mode:0o600});
 c=await connect(dir);try{await expectError(c,'wecom_table_structure',{url},'AUTH_EXPIRED');}finally{await c.close();}
}finally{await rm(dir,{recursive:true,force:true});}
await writeFile(join(dataDir,'error-report.json'),JSON.stringify({verified:true,results},null,2),{mode:0o600});
console.log(JSON.stringify({verified:true,results}));
