// CSS 选择器常量 —— Odoo quotation 页面 DOM 定位
// 来源：MIGRATION_PLAN §2.3.1，经 Playwright 项目验证

/** Odoo quotation 主表格 */
export const QUOTATION_TABLE_SELECTOR =
  'div.o_field_widget.o_field_section_and_note_one2many table.o_section_and_note_list_view';

/** 所有业务数据行（非操作行、非空白行） */
export const QUOTATION_DATA_ROW_SELECTOR = 'tbody tr.o_data_row';

/** 当前被选中的编辑行 */
export const QUOTATION_SELECTED_ROW_SELECTOR = 'tbody tr.o_data_row.o_selected_row';

/** 产品型号 autocomplete 输入框 */
export const PRODUCT_AUTOCOMPLETE_INPUT_SELECTOR =
  'td.o_sol_product_many2one_cell input.o-autocomplete--input';

/** autocomplete 下拉菜单容器 */
export const PRODUCT_AUTOCOMPLETE_MENU_SELECTOR =
  'td.o_sol_product_many2one_cell ul.o-autocomplete--dropdown-menu';

/** 下拉菜单的具体选项 */
export const PRODUCT_AUTOCOMPLETE_ITEM_SELECTOR =
  'td.o_sol_product_many2one_cell li.o-autocomplete--dropdown-item a.dropdown-item';

/** 可编辑的数量输入框（排除只读态） */
export const EDITABLE_QUANTITY_INPUT_SELECTOR =
  'td.o_data_cell.o_field_cell.o_list_number.o_required_modifier:not(.o_readonly_modifier) input.o_input';

/** "Add a product" 添加行链接 —— 在 tbody 非直属的 td 内，由 a 标签直接触发 */
export const ADD_PRODUCT_LINK_SELECTOR = 'td.o_field_x2many_list_row_add > a';

/** 行删除按钮 */
export const REMOVE_ROW_BUTTON_SELECTOR = 'td.o_list_record_remove button.fa-trash-o';

/** 点击标题区域以取消选中行（让当前编辑行退出 o_selected_row 状态） */
export const SELECT_CANCELLING = 'h1 > div.o_field_widget.o_readonly_modifier.o_required_modifier > span';

/** 产品型号单元格（用于读取已有行的产品名） */
export const PRODUCT_CELL_SELECTOR = 'td.o_sol_product_many2one_cell';

/** 已保存行中的折扣单元格（读取用） */
export const DETAIL_DISCOUNT_CELL_SELECTOR = 'td[name="discount"]';

/** 编辑态折扣输入框（编辑行内，o_field_float） */
export const EDITABLE_DISCOUNT_INPUT_SELECTOR = 'td[name="discount"] input.o_input';
