# 商家信息采集

## 当前状态

阶段 2 已实现 `/merchant-collection` 搜索页面，仅允许 `admin` 和 `manager`。页面通过 `POST /api/merchants/search` 获取 Google Places 商家候选；当前结果只保存在 React 组件内存中，刷新、离开页面或重新搜索都会丢弃，不写入 `localStorage`、IndexedDB 或服务端数据库。

官网首页提取、人工确认、本地名录、编辑和 CSV 导入导出属于后续阶段，当前页面不提供这些操作。

## 入口与权限

- `client/src/App.tsx` 使用 `RoleGuard allowedRoles={['admin', 'manager']}` 保护页面。
- 清单主页仅对 admin/manager 显示“商家采集”入口。
- 前端 guard 用于页面体验；服务端路由仍独立执行相同角色校验。

## 搜索表单

页面要求三个字段：

- 商家类别或服务：1～200 个字符，例如 `kitchen cabinet stores`。页面提示不要把经纬度写入查询词。
- 中心坐标：`纬度, 经度` 格式，只接受连续 48 州近似包围框内的中心点。
- 矩形半宽：大于 0 且不超过 50 km。输入 `10` 表示向东、西、南、北各约延伸 10 km。

客户端先执行与服务端一致的基础校验，再通过 `fetchWithAuth` 提交 JSON。请求进行中禁用输入；离开页面会用 `AbortController` 取消在途请求。客户端校验失败、开始新搜索或服务端返回不可识别数据时不会继续显示上一轮结果。

## 临时结果

结果区显示：

- 去重后的结果数和成功读取页数。
- 商家名称、Place ID、地址、坐标、电话、官网、营业状态和 Google Maps 链接。
- `possiblyTruncated` 对应的“范围内可能还有其他商家”提示。
- 后续页失败时服务端返回的 `partial` 和固定警告。
- 无结果、加载、网络失败和 API 错误状态。

官网和 Google Maps URL 即使来自 Google 也按不可信输入处理：页面只把合法 `http:`/`https:` URL 渲染为外链，并使用新窗口隔离属性。当前不会自动访问商家官网。

桌面使用结果表格；窄屏保持原生表格语义并允许横向滚动。Google Maps attribution 始终位于结果区底部，同时提供搜索排序因素说明链接。

## 后续阶段边界

阶段 3 才会增加商家选择和官网首页提取。阶段 4 才会建立 IndexedDB 本地名录和 CSV 流程。在人工确认功能实现前，当前 Google 候选不能被视为已收录商家。
