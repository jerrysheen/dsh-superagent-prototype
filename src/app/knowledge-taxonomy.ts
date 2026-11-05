/** Human browsing taxonomy. Topic relationships describe navigation, not verified causal claims. */
export const knowledgeDomains = [
  ['graphics', '游戏引擎与图形技术', '图形数学、GPU 执行、渲染架构、材质、地形与界面。'],
  ['runtime', '语言、运行时与跨平台工程', '语言语义、GC、AOT、WASM、资源交付与跨平台构建。'],
  ['diagnostics', '性能诊断与可观测性', '内存、CPU/GPU、帧级追踪与分析工具。'],
  ['ai', 'AI Agent 与知识系统', '主 Agent、Worker、工具接入、上下文与知识证据。'],
  ['games', '游戏产品与用户研究', '玩家研究、产品分析、玩法与游戏行为验证。'],
  ['market', '金融市场与决策分析', '市场机制、投资工具、风险分析与行情数据。'],
  ['productivity', '工作方法与通用知识', '学习、文档、内容工具、日程与开发环境。'],
].map(([id, name, summary]) => ({ id: id!, name: name!, summary: summary! }))

const definitions: [string, string, string, string, string, string[]][] = [
  ['scene-data','graphics','场景数据与 GPUScene','场景对象怎样转为 GPU 可消费的数据，如何处理脏数据、上传与间接绘制。','gpuscene|gpu.?driven|vertex pulling|renderproxy|scene payload|脏数据|间接绘制|draw.?indirect',['frame-sync','render-pipeline','terrain']],
  ['frame-sync','graphics','帧生命周期与线程同步','主线程、渲染线程和 GPU 之间的帧归属、队列依赖、Buffer 复用与同步。','framecontext|frameticket|frame.?stamp|renderbackend|ring.?buffer|fence|acquire|release|spsc|帧同步|多帧|环形缓冲|copy 队列|分配器|buffer 生命周期',['scene-data','gpu-binding','cpu-gpu']],
  ['gpu-binding','graphics','D3D12 资源与绑定','描述符、常量缓冲、资源状态和 GPU 地址的约束。','d3d12|cbv|srv|uav|root.?table|descriptor|perdraw|byteaddressbuffer|shader.?reflection|资源绑定|资源状态|256 字节|gpu 地址',['frame-sync','render-pipeline']],
  ['render-pipeline','graphics','渲染管线与合批','RenderGraph、渲染 Pass、状态组织与批次执行。','rendergraph|render.?pass|drawpass|rendercommand|render.?pipeline|forward\\+|residentdrawer|渲染管线|渲染架构|合批|状态哈希',['scene-data','gpu-binding','ui-rendering']],
  ['terrain','graphics','地形、植被与大世界','地形 Patch、LOD、流式加载、植被分布和跨引擎迁移。','terrain|地形|植被|pure.?nature|mountain|far cry|mesh.?lod|地格|heightmap|height.?map|草分布|树木|cross.?fade',['scene-data','virtual-texture','shadows']],
  ['virtual-texture','graphics','虚拟纹理与资源寻址','AVT、RVT、页表、反馈和压缩纹理池。','\\bavt\\b|\\brvt\\b|virtual.?texture|虚拟纹理|间接寻址|页表|压缩黑图|texture.?pool',['terrain','texture-delivery']],
  ['shadows','graphics','阴影、遮挡与深度','VSM、HIZ、Shadowmask、深度采样与遮挡剔除。','\\bvsm\\b|\\bhiz\\b|shadow|阴影|遮挡|遮蔽|深度采样|深度写入|ztest|stencil',['scene-data','ambient','shader-effects']],
  ['ambient','graphics','AO、光照与后处理','SSAO、HBAO、环境光和屏幕空间效果。','ssao|hbao|ambient.?occlusion|环境光|sinoldh|后处理|contact shadow|光照剔除|lightmap',['shadows','shader-effects','graphics-math']],
  ['graphics-math','graphics','图形数学与 GPU 基础','坐标变换、投影与深度、纹理采样和 GPU 硬件执行。','矩阵|投影|重心坐标|基底|mipmap|纹理采样|坐标空间|浮点精度|gpu 硬件|gpu hardware',['learning','gpu-binding','shadows']],
  ['mono-gc','runtime','Mono、GC 与托管堆','垃圾回收、对象分配、GC.Alloc 与托管堆的解释模型。','\\bmono\\b|\\bsgen\\b|\\bgc\\b|gc\\.alloc|managed.?heap|托管堆|垃圾回收|分代回收|lua gc',['memory-analysis','il2cpp']],
  ['il2cpp','runtime','IL2CPP 与执行模型','程序集、元数据、原生模块与 C# 执行的对应关系。','il2cpp|monomanager|globalmetadata|csharp|c# 执行|执行模型|unityengine 模块|物理代码|静态elf|符号表',['mono-gc','clr','wasm']],
  ['clr','runtime','热更新运行时与 AOT','HybridCLR、LeanCLR、泛型、裁剪与热更新桥接。','hybridclr|leanclr|\\baot\\b|热更 dll|热更新 dll|link\\.xml|illink|泛型|hotfixprojectstrip|反射启动|程序集裁剪',['il2cpp','versions','wasm']],
  ['wasm','runtime','WASM 与代码加载','代码体积、WebCIL、函数拆分、按需补齐与运行时加载。','wasm|webcil|blazor|代码膨胀|代码内存|函数拆分|lazyloadassembly|按需补齐|callmain',['clr','startup','memory-analysis']],
  ['build','runtime','构建与打包链路','构建入口、导出规则、压缩、程序集和产物校验。','autobuilder|build failed|builderror|打包|构建|export_project|exportproject|jenkins|gzip|brotli|lz4|contiguousbundles',['startup','bundles','versions']],
  ['startup','runtime','首包与启动流程','启动依赖、首场景、预下载、预热和启动耗时。','首包|启动流程|启动卡顿|首场景|preloadscene|预下载|预热|bootstrap|gamestep|gamemain|进城|登录卡住|启动依赖',['build','wasm','bundles']],
  ['bundles','runtime','资源依赖与 AssetBundle','依赖收集、Bundle 加载顺序、资源分组与资源表。','assetbundle|yooasset|资源依赖|依赖搜集|依赖收集|资源包|资源表|collector|bundle 加载|bundle.*打包|资源路径',['cdn','texture-delivery','shader-governance']],
  ['cdn','runtime','CDN、下载与本地资源服务','资源地址映射、并发下载、远端缺失和本地访问。','\\bcdn\\b|localcdn|下载|资源404|资源 404|资源未同步|资源访问|远端访问|局域网访问|resourcehook|资源服务',['bundles','versions','startup']],
  ['versions','runtime','热更新、数据表与版本兼容','底包与热更版本、Meta 数据、配置表及兼容迁移。','热更新|热补丁|版本判断|codeversion|meta\\.bytes|metamanager|meta package|配置表|打表|表打包|双格式|格式迁移',['clr','build','cdn']],
  ['texture-delivery','runtime','纹理压缩与资源分包','纹理格式、双资源包、压缩纹理及平台适配。','纹理分包|双资源包|双版本.*资源|纹理.*格式|dxtc|basis|compressed.?texture|纹理四倍|纹理 hook',['bundles','virtual-texture']],
  ['shader-governance','graphics','Shader 与材质治理','材质异常、关键字、Shader 家族、变体收集与分析缓存。','材质异常|shader.*变体|shadervariant|\\bsvc\\b|shader.*收敛|shader.*分类|material.?analyzer|shader.?scan|renderqueue|cull off|opaque|材质扫描|关键字|关键词导出',['bundles','profiler-tools','shader-effects']],
  ['shader-effects','graphics','材质效果、迷雾与渲染表现','描边、溶解、混合、雾效、透明度与贴图效果。','shader|材质|迷雾|fogdata|dissolve|outline|vignette|distort|混合|贴图|紫屏|黑边',['shadows','shader-governance','ui-tween']],
  ['ui-tween','graphics','界面动效与组件行为','NGUI、UITweener、UIPlayTween、透明度传播与编辑器预览。','tween|ngui|扫光|easing|camerashake|uisprite|uitexture|旋转与声音|动效',['ui-rendering','shader-effects']],
  ['ui-rendering','graphics','UI 绘制、交互与布局','UGUI、Dirty、合批、文本与界面布局交互。','ugui|ui.*dirty|canvas.*合批|文本耗时|界面布局|前端页面|交互|滚动|缩放|样式|markdown|预览|ui 风格',['ui-tween','render-pipeline','knowledge-structure']],
  ['memory-analysis','diagnostics','内存分析与快照','快照前后对照、分配时间线、未追踪内存和模块归因。','memory.?profiler|memory_map|内存|快照|heap|alloc|内存归因|分配时间线|loli_profiler',['mono-gc','wasm','profiler-tools']],
  ['cpu-gpu','diagnostics','CPU、GPU 与帧级性能','帧耗时、热点、瓶颈与 CPU/GPU 等待的证据分析。','profiler|性能|耗时|瓶颈|waitfortargetfps|renderdoc|tracy|帧率|帧数据|帧级|帧标记',['frame-sync','memory-analysis','profiler-tools']],
  ['profiler-tools','diagnostics','分析工具与数据口径','Profiler CSV、树结构、预算、FrameDebugger 和材质分析工具。','profiler.*mcp|profileranalyzer|profiler csv|csv.*口径|csv.*统计|frame.?debugger|预算查询|层级预算|材质分析|缓存.*csv|数据口径|memory_analyzer',['cpu-gpu','memory-analysis','shader-governance']],
  ['session-system','ai','会话协作与任务中枢','会话目录、目标定位、任务生命周期、回执和 Agent 协作架构。','super.?agent|\\bdsh\\b|会话|sessionhub|session.?router|任务.*agent|agent.*任务|agent runtime|执行回执|目标定位|thread|任务中枢',['knowledge-structure','ai-protocols','ai-sources']],
  ['ai-protocols','ai','模型协议与工具接入','Provider 协议、模型连通性、MCP 与工具配置。','provider|协议|mcp|模型.*连通|接口.*连通|anthropic|claude code|codex api|openclaw|claw code|api 分流',['session-system','profiler-tools','local-environment']],
  ['ai-sources','ai','AI 应用与来源架构','AI Hub、AI Center、Source Foundation 与应用集成。','ai.?hub|ai.?center|source foundation|信源|instance 化|v3-lite|鸿蒙|sources.*自动',['session-system','market-data','knowledge-structure']],
  ['knowledge-structure','ai','知识结构、笔记与历史整理','知识簇、笔记树、RAG、证据来源、合并与历史回查。','知识|笔记|obsidian|\\brag\\b|sbrain|secondbrain|concept_tree|merges|合并笔记|历史对话',['learning','session-system','graphics-math']],
  ['learning','productivity','学习主线与复习产物','面试、复习、Canvas、图解及 Word/PPT 等学习产物。','复习|面试|canvas|图解|word|ppt|学习总结|知识覆盖率|速记',['graphics-math','knowledge-structure']],
  ['game-restoration','games','游戏复原与行为验证','Planet Miner 等游戏的资源恢复、行为还原与 smoke 验证。','planet.?miner|restor|还原|复原|runtime smoke|empty.bundle|恢复验证|恢复计划',['ts-framework','build','bundles']],
  ['ts-framework','games','JS 转 TS 与框架脚手架','TypeScript 迁移、框架分层、脚手架与运行时边界。','js 转 ts|typescript|ts framework|scaffold|脚手架|cocos|框架迁移|框架方案',['game-restoration','ai-sources']],
  ['market-data','market','行情信源与数据同步','行情接口、数据契约、可见数据、增量同步与市场信号。','行情|股票|同花顺|\\betf\\b|visible data|市场信号|financial.api|资金行为|增量.*同步|kronos',['market-ui','ai-sources']],
  ['market-ui','market','看盘、预警与行情界面','市场、自选、行情布局与本地预警工具。','看盘|预警|自选|行情.*页面|行情.*布局|创业板|科创板|金融模型',['market-data','local-environment']],
  ['voice','productivity','语音输入与转写','Sherpa、Whisper、流式输入、转写 Worker 与 GPU 依赖。','语音|转写|whisper|sherpa|录音|cublas|cudnn',['local-environment','content-tools']],
  ['content-tools','productivity','字幕、视频与内容工具','视频字幕、浏览器工具、内容获取与完成检测。','字幕|youtube|bilibili|sider|视频|浏览器工具|抠色',['voice','calendar']],
  ['calendar','productivity','日程与简报','自然语言日程、时间过滤和任务简报。','calendar|日程|简报|时间过滤',['content-tools','ai-sources']],
  ['local-environment','productivity','本地环境与开发维护','Windows 服务、端口、安装、Git/SVN 和依赖兼容。','windows|端口|pid|git|svn|cherry.pick|安装|环境|服务启停|一键启动|dll 依赖|cuda|npm|pnpm',['build','ai-protocols','voice']],
  ['cpp-language','runtime','C++ 语义与内存模型','对象生命周期、值语义、分配器与并发内存模型。','c\\+\\+|nrvo|\\brvo\\b|移动语义|拷贝消除|堆分配器|内存模型',['graphics-math','clr']],
  ['player-research','games','玩家研究与产品分析','访谈、问卷、用户画像、流失与回流、玩法和竞品。','问卷|访谈|用户画像|玩家|流失|回流|三谋|三国志|ro3|\\bslg\\b|竞品|留存',['game-restoration','learning']],
  ['macro-credit','market','宏观、信用与产业','信用、抵押、宏观传导与算力经济。','信用|抵押|宏观|算力经济|货币|通胀|利率',['investment-risk','market-data']],
  ['investment-risk','market','投资工具与风险决策','ETF、期货、基差、换月、仓位、杠杆与估值。','期货|基差|换月|仓位|杠杆|估值|因子|etf|投资组合',['macro-credit','market-data']],

]
export const knowledgeTopics = definitions.map(([id, domainId, name, summary, pattern, related]) => ({ id, domainId, name, summary, related, pattern: new RegExp(pattern, 'i') }))
export function publicKnowledgeTopics() { return knowledgeTopics.map(({ pattern: _pattern, ...topic }) => topic) }

export function classifyKnowledge(question: string, answer: string, title: string) {
  // Per-question evidence dominates the conversation title; directory names never establish membership.
  const direct = knowledgeTopics.flatMap(topic => {
    const questionHit = topic.pattern.test(question), answerHit = topic.pattern.test(answer)
    return questionHit || answerHit ? [{ id: topic.id, score: (questionHit ? 3 : 0) + (answerHit ? 2 : 0), basis: 'question-answer' as const }] : []
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 3)
  return direct.length ? direct : knowledgeTopics.filter(topic => topic.pattern.test(title)).slice(0, 2)
    .map(topic => ({ id: topic.id, score: 1, basis: 'conversation-title' as const }))
}
