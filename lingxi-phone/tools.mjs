const s=(description,extra={})=>({type:'string',description,...extra});
const n=(description)=>({type:'integer',description});
const b=(description)=>({type:'boolean',description});
const tool=(name,description,properties={},required=[])=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}});
export const TOOLS=[
  tool('kb_search','检索手机本地知识库。复用 DSH 原索引；semantic 可降级为关键词，返回来源路径。',{query:s('搜索问题'),limit:n('1–20'),mode:s('semantic 或 keyword',{enum:['semantic','keyword']})},['query']),
  tool('kb_mentions','对当前全部未删除笔记做精确字符串扫描，返回完整数量、行号和分页；不检索聊天。',{needle:s('精确字符串'),limit:n('1–200'),offset:n('分页起点')},['needle']),
  tool('kb_read','读取本地笔记及其修订号。path 必须来自检索/列表。',{path:s('笔记路径')},['path']),
  tool('kb_list','列出手机本地笔记。directory 为 knowledge/project/record/archive/writing/diary 或空。',{directory:s('分类'),limit:n('1–200'),offset:n('分页起点')}),
  tool('kb_create','新建本地笔记，出现在原知识库页面。不会隐式覆盖同名笔记；更新必须显式提供 path 和 revision。quality_check 默认检查 project/knowledge 的字节数和五个章节。',{title:s('标题'),content:s('Markdown 正文'),note_type:s('分类'),subdir:s('项目名称'),tags:s('逗号分隔标签'),status:s('draft/active/archived 或 none/todo/doing/done'),quality_check:b('默认 true'),path:s('更新时的原笔记路径'),revision:n('更新时的原修订号')},['title','content']),
  tool('kb_create_project_log','按灵犀模板新建项目开发记录；同日已存在则拒绝覆盖，需先读取后明确更新。',{project_name:s('项目'),goal:s('目标'),changed_files:s('改动文件'),key_implementation:s('关键实现'),verification:s('真实验证'),issues:s('问题'),next_steps:s('后续事项'),tags:s('逗号标签'),status:s('状态')},['project_name','goal','changed_files','key_implementation','verification']),
  tool('kb_upload','上传到手机本地库。Markdown/TXT 导入笔记，其他内容保存为附件且不声称已全文索引。file_path 是本手机路径。',{file_path:s('手机绝对路径'),content:s('文本'),content_base64:s('二进制 Base64'),filename:s('文件名'),target_dir:s('附件相对目录，默认 _assets'),note_type:s('文本分类')}),
  tool('kb_dashboard','查看原知识库统计以及手机适配版能力；不会调用云端。'),
  tool('kb_index_status','查看 DSH 原本地索引状态，不创建第二套索引。'),
  tool('kb_index_rebuild','启动 DSH 原增量索引更新；返回任务状态，不把已启动当作已完成。'),
  tool('kb_note_hygiene','只报告空壳、重复正文与重名，不删除或移动任何内容。',{quiet_ok:b('无问题时简短返回')}),
  tool('kb_memory_boundary_check','判断内容适合笔记还是长期记忆候选；不自动写记忆。',{summary:s('摘要'),task_type:s('任务类型')},['summary']),
  tool('memory_search','本适配版未接管长期记忆：返回明确的未配置状态。历史/Noema 继续使用 DSH 原 kb_memory_search 及其范围设置。',{query:s('记忆问题'),limit:n('1–20')},['query']),
  tool('kb_dual_search','检索本地笔记并明确返回长期记忆集成状态；不绕过原记忆范围。',{query:s('搜索问题'),limit:n('1–20')},['query']),
  tool('kb_ask','取回本地证据供当前聊天模型带引用回答；本工具不另发模型请求，不自动产生模型费用。',{question:s('问题')},['question'])
];
export const READ_ONLY=TOOLS.map(t=>t.name).filter(n=>!['kb_create','kb_create_project_log','kb_upload','kb_index_rebuild'].includes(n));
