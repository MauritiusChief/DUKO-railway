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

/** "My Quotations" facet 移除按钮 */
export const FACET_REMOVE_BUTTON = '.o_searchview_facet .o_facet_remove'

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
