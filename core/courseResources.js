// Some official child documents publish their files only inside the parent list.
async function fetchCourseChild(id, parentIds, fetchJson, requests = new Map()) {
  for (const parentId of parentIds || []) {
    if (!requests.has(parentId)) {
      requests.set(parentId, fetchJson(`https://s-file-1.ykt.cbern.com.cn/zxx/ndrs/special_edu/thematic_course/${encodeURIComponent(parentId)}/resources/list.json`));
    }
    const items = await requests.get(parentId);
    if (!Array.isArray(items)) throw new Error('官网课程资源列表格式异常');
    const child = items.find(item => item.id === id || item.global_resource_id === id);
    if (child) return child;
  }
  throw new Error(`官网课程列表中未找到资源 ${id}，已保留原目录`);
}
module.exports = { fetchCourseChild };
