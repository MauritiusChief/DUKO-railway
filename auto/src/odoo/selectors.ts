/**
 * Odoo CSS 选择器 —— 销售列表页 + 报价详情页
 *
 * 来源：experiment/html/ 下各 Odoo 页面截图的静态分析，
 *       同时复用 script/selectors.ts 中已生效的 11 项选择器。
 *
 * 分为三组：
 *   1. 销售列表页（搜索、facet、数据行）
 *   2. 报价详情页（标题、公司、确认）
 *   3. 报价表格（由 quotation-table.ts 消费，此处仅保留重复项以保持独立）
 */

// ==================================================================
//  销售列表页（/odoo/sales）
// ==================================================================

/** 搜索框 */
export const SALES_SEARCH_INPUT = 'input.o_searchview_input'

/** facet 容器（每个筛选项一个） */
export const SALES_FACET = '.o_searchview_facet'

/** facet 内的可见标签文本（如 "My Quotations"、搜索词等） */
export const SALES_FACET_VALUE = '.o_facet_value'

/** facet 移除按钮（位于 facet 容器内） */
export const FACET_REMOVE_BUTTON = '.o_facet_remove'

/** 列表容器 */
export const SALES_LIST_TABLE = 'table.o_list_table'

/** 列表数据行 */
export const SALES_DATA_ROW = 'tbody tr.o_data_row'

/** 列表行中的报价单号 cell（由 name="name" 标识） */
export const SALES_NAME_CELL = 'td[name="name"]'

// ==================================================================
//  报价详情页（odoo/sales/... 表单视图）
// ==================================================================

/** 详情页标题中的报价单号 */
export const DETAIL_QUOTATION_NUMBER = 'h1 div[name="name"] span'

/** 客户/公司输入框（Odoo many2one autocomplete 字段） */
export const DETAIL_PARTNER_INPUT = 'div[name="partner_id"] input'

/** 报价单表格容器（详情页内嵌的 order lines） */
export const QUOTATION_TABLE = 'div.o_field_widget.o_field_section_and_note_one2many table.o_section_and_note_list_view'

/** 报价单表格业务数据行 */
export const QUOTATION_DATA_ROW = 'tbody tr.o_data_row'

/** 报价单表格当前被选中的编辑行 */
export const QUOTATION_SELECTED_ROW = 'tbody tr.o_data_row.o_selected_row'

/** 已保存行中的产品型号单元格（读取用） */
export const DETAIL_PRODUCT_CELL = 'td[name="product_template_id"]'

/** 已保存行中的数量单元格（读取用） */
export const DETAIL_QUANTITY_CELL = 'td[name="product_uom_qty"]'

// ==================================================================
//  报价表格编辑态选择器（由 quotation-table.ts 消费）
// ==================================================================

/** 产品 autocomplete 输入框（编辑行内） */
export const PRODUCT_AUTOCOMPLETE_INPUT =
  'td.o_sol_product_many2one_cell input.o-autocomplete--input'

/** autocomplete 下拉菜单容器 */
export const PRODUCT_AUTOCOMPLETE_MENU =
  'td.o_sol_product_many2one_cell ul.o-autocomplete--dropdown-menu'

/** autocomplete 下拉菜单的具体选项 */
export const PRODUCT_AUTOCOMPLETE_ITEM =
  'td.o_sol_product_many2one_cell li.o-autocomplete--dropdown-item a.dropdown-item'

/** 可编辑的数量输入框（排除只读态） */
export const EDITABLE_QUANTITY_INPUT =
  'td.o_data_cell.o_field_cell.o_list_number.o_required_modifier:not(.o_readonly_modifier) input.o_input'

/** "Add a product" 链接（在 tbody 下方的操作行中） */
export const ADD_PRODUCT_LINK = 'tbody a:has-text("Add a product")'

/** 行删除按钮 */
export const REMOVE_ROW_BUTTON = 'td.o_list_record_remove button.fa-trash-o'

/** 点击标题区域以取消选中行 */
export const SELECT_CANCELLING = 'h1 > div.o_field_widget.o_readonly_modifier.o_required_modifier > span'

// ==================================================================
//  报价详情页 —— 表单保存按钮
// ==================================================================

/** 手动保存按钮（仅在表单 dirty 时显示） */
export const FORM_SAVE_BUTTON = '.o_form_button_save'

// ==================================================================
//  产品列表页（/odoo/products）—— inventory 下载流程
// ==================================================================

/** 表头"全选当前页"复选框 */
export const PRODUCT_SELECT_ALL_CHECKBOX = '.o_list_record_selector input[type="checkbox"]'

/** 选中后出现的提示条（含 "Select all" 按钮与计数） */
export const PRODUCT_SELECTION_BOX = '.o_list_selection_box'

/** "Select all" 按钮（把选择扩展到全部记录） */
export const PRODUCT_SELECT_ALL_DOMAIN_BUTTON = '.o_list_select_domain'

/** "All N selected" 全量选中状态容器 */
export const PRODUCT_ALL_SELECTED = '.o_list_selection_box:has-text("All")'

/** Actions 齿轮下拉按钮（data-hotkey=u） */
export const PRODUCT_ACTIONS_DROPDOWN = '.o_cp_action_menus button[data-hotkey="u"]'

/** 弹出菜单中的 Export 项 */
export const PRODUCT_EXPORT_MENU_ITEM = '.o_menu_item:has-text("Export")'

/** 导出数据对话框 */
export const EXPORT_DATA_DIALOG = '.o_export_data_dialog'

/** 导出模板下拉 */
export const EXPORT_TEMPLATE_SELECT = '.o_exported_lists_select'

/** "Inventory 核对"模板选项（value=29） */
export const EXPORT_TEMPLATE_INVENTORY = '.o_exported_lists_select option[value="29"]'

/** 已选导出字段列表（用于确认模板已应用） */
export const EXPORT_FIELDS_LIST = '.o_fields_list'

/** CSV 格式单选框 */
export const EXPORT_CSV_RADIO = '#o_radiocsv'

/** 导出按钮（对话框底部） */
export const EXPORT_BUTTON = '.o_export_data_dialog .o_select_button'

// ==================================================================
//  库存报表页（/odoo/action-809）—— inventory 趋势查验流程
// ==================================================================

/** 搜索框 */
export const INVENTORY_SEARCH_INPUT = '.o_searchview_input'

/** 搜索 facet 内的值标签 */
export const INVENTORY_FACET_VALUE = '.o_searchview_facet .o_facet_value'

/** facet 移除按钮 */
export const INVENTORY_FACET_REMOVE = '.o_facet_remove'

/** 库存报表数据行 */
export const INVENTORY_DATA_ROW = 'tr.o_data_row'

/** 行内的库位 cell（name=location_id） */
export const INVENTORY_LOCATION_CELL = 'td[name="location_id"]'

/** 行内产品名 cell（name=product_id） */
export const INVENTORY_PRODUCT_CELL = 'td[name="product_id"]'

/** 行内 On Hand 数量 cell（name=inventory_quantity_auto_apply） */
export const INVENTORY_QTY_CELL = 'td[name="inventory_quantity_auto_apply"]'

/** "History" 按钮（查看该库位的库存移动） */
export const INVENTORY_HISTORY_BUTTON = 'button[name="action_view_stock_moves"]'

/** 库存移动表数据行 */
export const STOCK_MOVE_DATA_ROW = 'tr.o_data_row'

/** 库存移动行的日期 cell */
export const STOCK_MOVE_DATE_CELL = 'td[name="date"]'

/** 库存移动行的出发库位 cell */
export const STOCK_MOVE_LOCATION_CELL = 'td[name="location_id"]'

/** 库存移动行的目的库位 cell */
export const STOCK_MOVE_DEST_CELL = 'td[name="location_dest_id"]'

/** 库存移动行的数量 cell */
export const STOCK_MOVE_QTY_CELL = 'td[name="quantity"]'
