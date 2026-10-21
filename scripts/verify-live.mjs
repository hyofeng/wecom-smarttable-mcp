import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { dataDir } from '../dist/local.js';
import { createHash } from 'node:crypto';
process.umask(0o077);
const targetPath=process.argv[2];
if(!targetPath) throw new Error('Usage: node scripts/verify-live.mjs <private-target.json>');
const {url}=JSON.parse(await readFile(targetPath,'utf8'));
const client=new Client({name:'wecom-real-verifier',version:'0.1.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/server.js')],stderr:'pipe'});
let stderr='';transport.stderr?.on('data',data=>{stderr+=data.toString()});
const report={sheets:[],image:null,attachment:null,file:null};
async function call(name,args) {
 const result=await client.callTool({name,arguments:args});
 if(result.isError) throw new Error(`MCP verification failed: ${name}`);
 assert.ok(result.structuredContent);
 return result;
}
try {
 await client.connect(transport);
 const tools=await client.listTools();
 assert.deepEqual(tools.tools.map(t=>t.name).sort(),['wecom_download_asset','wecom_read_records','wecom_table_structure']);
 const s=(await call('wecom_table_structure',{url})).structuredContent;
 for(const table of s.sheets) {
  const seen=new Set();let cursor;let pages=0;let total;let firstImage;let firstAttachment;let firstNative;
  do {
   const p=(await call('wecom_read_records',{url,sheet_id:table.id,page_size:31,...(cursor?{cursor}:{})})).structuredContent;
   assert.equal(p.scope,'whole_table_accessible_to_current_user');assert.equal(p.view_filter_applied,false);
   assert.equal(p.total_records,table.total_records_in_table);
   assert.equal(p.returned_count,p.records.length);
   assert.equal(p.range.start_index,seen.size);
   assert.equal(p.range.end_index_exclusive,seen.size+p.records.length);
   for(const row of p.records) {
    assert.ok(!seen.has(row.id),'duplicate record across pages');seen.add(row.id);
    for(const field of table.fields.filter(f=>[5,6].includes(f.type_code))) {
     assert.ok(row.fields[field.id]);
     for(const asset of row.fields[field.id].assets) {
      assert.equal(asset.locator.record_id,row.id);assert.equal(asset.locator.field_id,field.id);
      assert.equal(asset.locator.sheet_id,table.id);assert.equal(asset.locator.chunk_start,p.range.start_index);
      if(asset.kind==='image'&&!firstImage) firstImage=asset;
      if(asset.kind==='attachment'&&!firstAttachment) firstAttachment=asset;
      if(asset.kind==='attachment'&&asset.source==='SS_File'&&!firstNative) firstNative=asset;
     }
    }
   }
   total=p.total_records;pages++;cursor=p.next_cursor;
   assert.equal(p.has_more,Boolean(cursor));
   if(p.has_more) assert.ok(p.returned_count>0);
  } while(cursor);
  assert.equal(seen.size,total);
  report.sheets.push({id:table.id,total,unique:seen.size,pages});
  console.log(JSON.stringify({sheet_index:report.sheets.length,total,unique:seen.size,pages}));
  if(firstImage&&!report.image) {
   const result=await call('wecom_download_asset',{url,locator:firstImage.locator});
   report.image=result.structuredContent;
   const data=await readFile(report.image.local_path);
   assert.equal(createHash('sha256').update(data).digest('hex'),report.image.sha256);
   assert.equal(data.length,report.image.size_bytes);
   const image=result.content.find(c=>c.type==='image');
   assert.ok(image);assert.ok(data.equals(Buffer.from(image.data,'base64')));
   console.log(JSON.stringify({image_verified:true,size_bytes:report.image.size_bytes,mime_type:report.image.mime_type}));
  }
  if(firstAttachment&&!report.attachment) report.attachment=firstAttachment;
  if(firstNative&&!report.file){
   const result=await call('wecom_download_asset',{url,locator:firstNative.locator});
   report.file=result.structuredContent;
   const data=await readFile(report.file.local_path);
   assert.equal(createHash('sha256').update(data).digest('hex'),report.file.sha256);
   assert.equal(data.length,firstNative.size);
   console.log(JSON.stringify({attachment_verified:true,size_bytes:report.file.size_bytes,mime_type:report.file.mime_type}));
  }
 }
 const state=JSON.parse(await readFile(join(dataDir,'state.json'),'utf8'));
 const output=JSON.stringify(report)+stderr;
 assert.ok(!state.cookies.some(c=>c.value.length>=12&&output.includes(c.value)),'credential leak');
 assert.equal(stderr,'');
 await writeFile(join(dataDir,'live-report.json'),JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify({verified:true,total:report.sheets.reduce((n,s)=>n+s.total,0),image_downloaded:!!report.image,attachment_found:!!report.attachment,file_downloaded:!!report.file}));
} finally {await client.close();}
