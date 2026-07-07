/**
 * 国际化翻译字典
 *
 * 所有 UI 字符串以中文 key 标识，每个 key 对应 zh / en 两种语言。
 */
export type Lang = 'zh' | 'en';

export type TranslationKey = keyof typeof messages;

export const messages = {
  /* ---- TableParsePage ---- */
  页面标题: {
    zh: 'DUKO 清单解析',
    en: 'DUKO Quote Parser',
  },
  页面说明: {
    zh: '粘贴客户报价清单文本，AI 将自动解析为结构化表格',
    en: 'Paste customer quote list; AI will parse into a structured table',
  },
  下载脚本: {
    zh: '下载 ScriptCat 脚本',
    en: 'Download ScriptCat Script',
  },
  输入框提示: {
    zh: '在此粘贴客户清单，每行一项物品...\n例如：\n02B15\nWhite base cabinet\n2 x 18 inch wall cabinet',
    en: 'Paste customer list here, one item per line...\nExamples:\n02B15\nWhite base cabinet\n2 x 18 inch wall cabinet',
  },
  颜色提示: {
    zh: '涉及颜色（可选，帮助 AI 识别）：',
    en: 'Colors involved (optional, helps AI):',
  },
  解析中: {
    zh: '解析中...',
    en: 'Parsing...',
  },
  解析清单: {
    zh: '解析清单',
    en: 'Parse List',
  },
  快捷键提示: {
    zh: 'Ctrl + Enter 快捷提交',
    en: 'Ctrl + Enter to submit',
  },
  加载存档: {
    zh: '加载存档',
    en: 'Load Archive',
  },
  解析结果: {
    zh: '解析结果',
    en: 'Parsed Results',
  },
  行数标签: {
    zh: '行数',
    en: 'Rows',
  },
  行数: {
    zh: '{n} 行',
    en: '{n} rows',
  },
  原始名称: {
    zh: '原始名称/型号',
    en: 'Original Name/Model',
  },
  颜色: {
    zh: '颜色',
    en: 'Color',
  },
  形状型号: {
    zh: '形状型号',
    en: 'Shape Type',
  },
  形状尺寸: {
    zh: '形状尺寸',
    en: 'Shape Size',
  },
  数量: {
    zh: '数量',
    en: 'Qty',
  },
  定制要求: {
    zh: '要求',
    en: 'Req',
  },
  door: {
    zh: '柜门',
    en: 'Door',
  },
  box: {
    zh: '柜体',
    en: 'Box',
  },
  操作: {
    zh: '操作',
    en: 'Action',
  },
  删除此行: {
    zh: '删除此行',
    en: 'Delete this row',
  },
  生成中: {
    zh: '生成中...',
    en: 'Generating...',
  },
  生成产品清单: {
    zh: '生成产品清单',
    en: 'Generate Product List',
  },
  保存存档: {
    zh: '保存为存档',
    en: 'Save as Archive',
  },
  产品清单: {
    zh: '产品清单',
    en: 'Product List',
  },
  项数: {
    zh: '{n} 项',
    en: '{n} items',
  },
  未解析提示: {
    zh: '有 {n} 行未能解析（行号：{rows}），已跳过。',
    en: '{n} rows could not be resolved (rows: {rows}), skipped.',
  },
  SKU: {
    zh: 'SKU',
    en: 'SKU',
  },
  描述: {
    zh: '描述',
    en: 'Description',
  },
  复制CSV: {
    zh: '复制 CSV',
    en: 'Copy CSV',
  },
  已复制: {
    zh: '已复制到剪贴板',
    en: 'Copied to clipboard',
  },
  未知: {
    zh: '未知',
    en: 'Unknown',
  },

  /* ---- ChatPanel ---- */
  对话: {
    zh: '对话',
    en: 'Chat',
  },
  笔记: {
    zh: '笔记',
    en: 'Notes',
  },
  笔记内容: {
    zh: '内容',
    en: 'Content',
  },
  对话框示例_color: {
    zh: '试试输入“把所有 QR 的颜色改成02”',
    en: 'Try type "Change all QR colors to 02"',
  },
  对话框示例_qty: {
    zh: '试试输入“将 W1830 的数量改为 3”',
    en: 'Try type "Change W1830 quantity to 3"',
  },
  对话框示例_size: {
    zh: '试试输入“把 B15 的形状尺寸改成 36 inch”',
    en: 'Try type "Change B15 shape size to 36 inch"',
  },
  对话框示例_add: {
    zh: '试试输入“增加一个 B24 白色地柜”',
    en: 'Try type "Add a B24 white base cabinet"',
  },
  对话框示例_delete: {
    zh: '试试输入“删除所有 02 颜色的柜子”',
    en: 'Try type "Remove all cabinets with color 02"',
  },
  对话框示例_door: {
    zh: '试试输入“把所有壁柜的改为只需要门”',
    en: 'Try type "Change all wall cabinets to only require door"',
  },
  对话框示例_export: {
    zh: '试试提问“VSB24 有几个抽屉和门？”',
    en: 'Try ask "How many drawers and doors does VSB24 include?"',
  },
  对话框示例_sku: {
    zh: '试试提问“UT1893 包含哪些零件？”',
    en: 'Try ask "What parts does UT1893 include?"',
  },
  对话框示例_correct: {
    zh: '试试输入“leg 的意思其实是 CP334”',
    en: 'Try type "leg actually means CP334"',
  },
  你: {
    zh: '你',
    en: 'You',
  },
  助手: {
    zh: '助手',
    en: 'Assistant',
  },
  工具: {
    zh: '工具',
    en: 'Tools',
  },
  思考中: {
    zh: '思考中...',
    en: 'Thinking...',
  },
  正在调用: {
    zh: '正在调用',
    en: 'Calling',
  },
  对话输入提示: {
    zh: '粘贴客户提问或报价修改要求，或直接提问\nEnter 发送，Shift+Enter 换行',
    en: 'Paste customer question, request to modify quote, or ask question directly; Enter to send, Shift+Enter to break',
  },
  发送: {
    zh: '发送',
    en: 'Send',
  },
  请求失败: {
    zh: 'LLM 请求失败',
    en: 'LLM request failed',
  },
  抱歉前缀: {
    zh: '抱歉，',
    en: 'Sorry, ',
  },
  网络错误: {
    zh: '请求失败，请稍后重试。',
    en: 'Request failed, please try again later.',
  },

  /* ---- Store errors suffix ---- */
  联系支持: {
    zh: '请联系技术人员解决此问题。',
    en: 'Please contact technical support.',
  },

  /* ---- Image mode ---- */
  文本模式: {
    zh: '文本',
    en: 'Text',
  },
  图片模式: {
    zh: '图片',
    en: 'Image',
  },
  图片上传提示: {
    zh: '将图片粘贴到此区域（Ctrl+V）\n或点击选择文件',
    en: 'Paste image here (Ctrl+V)\nor click to browse',
  },
  图片追加提示: {
    zh: '继续粘贴或选择更多图片（Ctrl+V）',
    en: 'Paste or select more images (Ctrl+V)',
  },
  处理图片: {
    zh: '处理图片',
    en: 'Process Image',
  },
  图片处理中: {
    zh: '处理中...',
    en: 'Processing...',
  },
  清除图片: {
    zh: '清除',
    en: 'Clear',
  },
  图片格式错误: {
    zh: '仅支持图片文件（PNG、JPEG、WebP 等）',
    en: 'Only image files are supported (PNG, JPEG, WebP, etc.)',
  },
  浏览: {
    zh: '浏览...',
    en: 'Browse...',
  },

  /* ---- LayoutRecognizePage ---- */
  布局识别: {
    zh: '布局识别',
    en: 'Layout Recognize',
  },
  布局识别说明: {
    zh: '通过图片或手工编辑橱柜布局，识别墙/岛台上柜体之间的关系',
    en: 'Recognize cabinet layout relationships on walls via images or manual editing',
  },
  布局识别对话提示: {
    zh: '上传 layout 图片后，我会实时显示识别过程和工具调用。',
    en: 'After uploading a layout image, I will show the recognition process and tool calls in real time.',
  },
  新建布局: {
    zh: '新建布局',
    en: 'New Layout',
  },
  导入布局: {
    zh: '导入布局',
    en: 'Import Layout',
  },
  导出布局: {
    zh: '导出布局',
    en: 'Export Layout',
  },
  删除布局: {
    zh: '删除布局',
    en: 'Delete Layout',
  },
  布局名称: {
    zh: '布局名称',
    en: 'Layout Name',
  },
  切换布局: {
    zh: '切换布局',
    en: 'Switch Layout',
  },
  无布局: {
    zh: '暂无布局，请新建一个',
    en: 'No layouts yet, create one',
  },
  无效的布局文件: {
    zh: '无效的布局 JSON 文件',
    en: 'Invalid layout JSON file',
  },
  新建空白布局确认: {
    zh: '新建一个空白布局？未保存的更改将丢失。',
    en: 'Create a new blank layout? Unsaved changes will be lost.',
  },
  墙面岛台: {
    zh: '墙面/岛台',
    en: 'Wall/Island',
  },
  添加墙面: {
    zh: '添加墙面',
    en: 'Add Wall',
  },
  添加岛台: {
    zh: '添加岛台',
    en: 'Add Island',
  },
  删除墙面: {
    zh: '删除墙面',
    en: 'Delete Wall',
  },
  删除岛台: {
    zh: '删除岛台',
    en: 'Delete Island',
  },
  删除墙面确认: {
    zh: '确认删除墙面 "{name}"？',
    en: 'Delete wall "{name}"?',
  },
  总宽度: {
    zh: '总宽度',
    en: 'Total Width',
  },
  左侧暴露: {
    zh: '左侧暴露',
    en: 'Left Exposed',
  },
  右侧暴露: {
    zh: '右侧暴露',
    en: 'Right Exposed',
  },
  后侧暴露: {
    zh: '后侧暴露',
    en: 'Back Exposed',
  },
  空中: {
    zh: '空中',
    en: 'Air',
  },
  地面: {
    zh: '地面',
    en: 'Ground',
  },
  距左: {
    zh: '距左',
    en: 'From Left',
  },
  宽度: {
    zh: '宽度',
    en: 'Width',
  },
  高度: {
    zh: '高度',
    en: 'Height',
  },
  添加物品: {
    zh: '添加物品',
    en: 'Add Item',
  },
  编辑物品: {
    zh: '编辑物品',
    en: 'Edit Item',
  },
  删除物品: {
    zh: '删除物品',
    en: 'Delete Item',
  },
  静态删除: {
    zh: '静态删除（留空位）',
    en: 'Static Delete (Leave Gap)',
  },
  动态删除: {
    zh: '动态删除（右侧左移）',
    en: 'Dynamic Delete (Shift Left)',
  },
  英寸: {
    zh: '英寸',
    en: 'in',
  },
  连接墙面: {
    zh: '连接墙面',
    en: 'Connected Walls',
  },
  背靠背: {
    zh: '背靠背',
    en: 'Back-to-back',
  },
  L形连接提示: {
    zh: 'L 形连接',
    en: 'L-shaped connection',
  },
  背靠背连接提示: {
    zh: '背靠背连接',
    en: 'Back-to-back connection',
  },
  拖拽提示: {
    zh: '拖拽以重新定位',
    en: 'Drag to reposition',
  },
  移除叠放物品: {
    zh: '移除叠放物品',
    en: 'Remove stacked item',
  },
  叠放吊柜: {
    zh: '叠放吊柜',
    en: 'Stack Wall Cabinet',
  },
  无墙面提示: {
    zh: '暂无墙面。点击 "+ 墙面/岛台" 添加一面。',
    en: 'No walls yet. Click "+ Wall/Island" to add one.',
  },
  请输入名称: {
    zh: '请输入名称',
    en: 'Enter name',
  },
  请输入宽度: {
    zh: '请输入宽度',
    en: 'Enter width',
  },
  请输入SKU: {
    zh: '请输入 SKU',
    en: 'Enter SKU',
  },
  // 物品分类标签
  吊柜: {
    zh: '吊柜',
    en: 'Wall Cabinet',
  },
  地柜: {
    zh: '地柜',
    en: 'Base Cabinet',
  },
  高柜: {
    zh: '高柜',
    en: 'Tall Cabinet',
  },
  空挡: {
    zh: '空挡',
    en: 'Gap',
  },
  抽油烟机: {
    zh: '抽油烟机',
    en: 'Range Hood',
  },
  窗户: {
    zh: '窗户',
    en: 'Window',
  },
  高电器: {
    zh: '高电器',
    en: 'Tall Appliance',
  },
  需台面电器: {
    zh: '需台面电器',
    en: 'Appliance w/ Countertop',
  },
  免台面电器: {
    zh: '免台面电器',
    en: 'Appliance w/o Countertop',
  },

  /* ---- BlockInfoBar ---- */
  双轨联动: {
    zh: '双轨联动（空中+地面）',
    en: 'Dual-track (Air + Ground)',
  },
  叠放提示: {
    zh: '叠放 {n} 个吊柜',
    en: '{n} stacked cabinet(s)',
  },
  物品信息: {
    zh: '物品信息',
    en: 'Item Info',
  },
  关闭: {
    zh: '关闭',
    en: 'Close',
  },
  添加叠放: {
    zh: '+ 叠放',
    en: '+ Stack',
  },
  选择颜色: {
    zh: '颜色',
    en: 'Color',
  },
  无颜色: {
    zh: '(无)',
    en: '(None)',
  },
  浴室柜: {
    zh: 'Vanity Cabinet',
    en: 'Vanity Cabinet',
  },

  /* ---- ImageUploadPanel ---- */
  图片识别: {
    zh: '图片识别',
    en: 'Image Recognition',
  },
  拖拽图片提示: {
    zh: '拖拽图片到此处或点击选择',
    en: 'Drag image here or click to select',
  },
  视图类型: {
    zh: '视图类型',
    en: 'View Type',
  },
  俯视图: {
    zh: '俯视图',
    en: 'Top View',
  },
  正视图: {
    zh: '正视图',
    en: 'Elevation View',
  },
  立体图: {
    zh: '立体图',
    en: '3D View',
  },
  关联墙面岛台: {
    zh: '关联墙/岛台',
    en: 'Associated Wall/Island',
  },
  识别中: {
    zh: '识别中...',
    en: 'Recognizing...',
  },
  识别此图片: {
    zh: '识别此图片',
    en: 'Recognize This Image',
  },
  识别失败: {
    zh: '识别失败',
    en: 'Recognition failed',
  },
  布局更新成功: {
    zh: '布局更新成功',
    en: 'Layout updated successfully',
  },
  网络请求失败: {
    zh: '网络请求失败，请检查连接',
    en: 'Network request failed, please check connection',
  },

  /* ---- Auth ---- */
  登录: {
    zh: '登录',
    en: 'Login',
  },
  已登录: {
    zh: '已登录',
    en: 'Logged In',
  },
  当前用户: {
    zh: '当前用户',
    en: 'Current user',
  },
  管理员: {
    zh: '管理员',
    en: 'Administrator',
  },
  普通用户: {
    zh: '普通用户',
    en: 'User',
  },
  进入系统: {
    zh: '进入系统',
    en: 'Enter System',
  },
  注册新用户: {
    zh: '注册新用户',
    en: 'Register New User',
  },
  取消注册: {
    zh: 'Cancel Registration',
    en: 'Cancel Registration',
  },
  确认注册: {
    zh: '确认注册',
    en: 'Confirm Registration',
  },
  注册中: {
    zh: '注册中...',
    en: 'Registering...',
  },
  登录中: {
    zh: '登录中...',
    en: 'Logging in...',
  },
  注册成功: {
    zh: '注册成功',
    en: 'Registration successful',
  },
  登出: {
    zh: '登出',
    en: 'Logout',
  },
  用户名: {
    zh: '用户名',
    en: 'Username',
  },
  密码: {
    zh: '密码',
    en: 'Password',
  },

  /* ---- HistoryPage ---- */
  历史记录: {
    zh: '历史记录',
    en: 'History',
  },
  回到主页: {
    zh: '回到主页',
    en: 'Back to Home',
  },
  无记录提示: {
    zh: '暂无历史记录',
    en: 'No history records yet',
  },
  填充回主页: {
    zh: '填充回主页',
    en: 'Fill Back to Main Page',
  },
  原始输入: {
    zh: '原始输入',
    en: 'Original Input',
  },
  对话记录: {
    zh: '对话记录',
    en: 'Conversation',
  },
  删除记录: {
    zh: '删除记录',
    en: 'Delete Record',
  },
  前往历史记录: {
    zh: '历史记录',
    en: 'History',
  },
  记录行数: {
    zh: '({n}行)',
    en: '({n} rows)',
  },
  行: {
    zh: '行',
    en: 'rows',
  },
  选择记录提示: {
    zh: '选择左侧记录查看详情',
    en: 'Select a record on the left',
  },

  /* ---- AllHistoryPage ---- */
  全部历史记录: {
    zh: '全部历史记录',
    en: 'All History',
  },
  归属用户: {
    zh: '归属用户',
    en: 'Owner',
  },

  /* ---- Admin User Management ---- */
  用户管理: {
    zh: '用户管理',
    en: 'User Management',
  },
  管理员密码: {
    zh: '管理员密码',
    en: 'Admin Password',
  },
  确认删除: {
    zh: '确认删除',
    en: 'Confirm Delete',
  },
  修改用户名: {
    zh: '修改用户名',
    en: 'Change Username',
  },
  修改密码: {
    zh: '修改密码',
    en: 'Change Password',
  },
  新用户名: {
    zh: '新用户名',
    en: 'New Username',
  },
  新密码: {
    zh: '新密码',
    en: 'New Password',
  },
  保存: {
    zh: '保存',
    en: 'Save',
  },
  取消: {
    zh: '取消',
    en: 'Cancel',
  },
  删除成功: {
    zh: '删除成功',
    en: 'Delete successful',
  },
  修改成功: {
    zh: '修改成功',
    en: 'Update successful',
  },
  种子管理员保护: {
    zh: '种子管理员账户不允许此操作',
    en: 'Seed admin account is protected',
  },
} as const;
