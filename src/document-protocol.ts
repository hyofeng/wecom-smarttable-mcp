import { requireData } from './errors.js';

type Raw = Record<string, any>;

export function parseDocumentRole(body: Raw, documentId: string) {
  requireData(Array.isArray(body.file_roles), '文档权限响应缺少文件映射。');
  const matches = body.file_roles.filter((role: Raw) => role.doc_id === documentId && role.file_info?.doc_id === documentId);
  requireData(matches.length === 1 && typeof matches[0].file_info.file_id === 'string'
    && matches[0].file_info.file_type === 70 && typeof matches[0].file_info.real_name === 'string'
    && Array.isArray(matches[0].role_info?.allow_operations), '无法确认智能表格的唯一文件 ID 或文档权限。');
  const role = matches[0];
  // 23 = 删除；25 = 永久删除，不可用作本工具的授权依据。
  return { fileId: role.file_info.file_id as string, title: role.file_info.real_name as string,
    canDelete: role.role_info.allow_operations.includes(23) };
}

export function parseRecyclePage(body: Raw, fileId: string) {
  requireData(typeof body.finish === 'boolean' && typeof body.sync_key_new === 'string'
    && (body.list === undefined || Array.isArray(body.list)), '回收站分页响应不完整。');
  const entries: Raw[] = body.list || [];
  requireData(entries.every(entry => entry && typeof entry.file_id === 'string'), '回收站文件标识结构发生变化。');
  // 实测回收站条目使用精确的原文件 ID + ".recycle"，不按标题或字符串前缀猜测。
  const matches = entries.filter(entry => entry.file_id === `${fileId}.recycle`);
  if (matches.length) requireData(matches.length === 1 && matches[0].file_type === 70 && matches[0].status === 2,
    '回收站中的目标文件类型、删除状态或唯一性未通过核对。');
  return { found: matches.length === 1, finished: body.finish as boolean, cursor: body.sync_key_new as string };
}
