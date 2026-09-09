# 分支节点条件配置 - 功能验证清单

## ✅ 已实现功能

### 1. UI 层 - NodePanel.vue

**分支条件配置界面**（第43-71行）：
```vue
<div class="branch-case">
  <!-- 条件标签 -->
  <el-input v-model="c.label" placeholder="条件标签" />
  
  <!-- 变量选择 -->
  <el-select v-model="c.when.slot">
    <el-option label="user_name" value="user_name" />
    <el-option label="phone_number" value="phone_number" />
    <el-option label="age" value="age" />
    <el-option label="is_vip" value="is_vip" />
  </el-select>
  
  <!-- 运算符 -->
  <el-select v-model="c.when.op">
    <el-option label="等于" value="eq" />
    <el-option label="不等于" value="neq" />
    <el-option label="大于" value="gt" />
    <el-option label="小于" value="lt" />
    <el-option label="大于等于" value="gte" />
    <el-option label="小于等于" value="lte" />
    <el-option label="包含" value="contains" />
    <el-option label="为空" value="empty" />
    <el-option label="不为空" value="not_empty" />
  </el-select>
  
  <!-- 值输入（'为空/不为空'时禁用） -->
  <el-input v-model="c.when.value" :disabled="['empty', 'not_empty'].includes(c.when.op)" />
</div>
```

**✅ 验证点：**
- [x] 条件标签可输入
- [x] 变量下拉可选择
- [x] 运算符下拉可选择（9种）
- [x] 值输入框在'为空/不为空'时自动禁用
- [x] 可以添加多个条件
- [x] 可以删除条件
- [x] 有示例提示文本

---

### 2. 数据转换层 - flowConverter.js

**Canvas → DSL**（buildBranchCases 函数，第215-245行）：
```javascript
function buildBranchCases(node, edges, nodeMap) {
  const d = node.data || {}
  const cases = d.cases || []
  
  // 优先使用节点配置的 conditions（新格式）
  if (cases.length > 0 && cases[0].when) {
    return cases.map(c => {
      const edge = edges.find(e => 
        e.source === node.id && 
        e.sourceHandle && 
        (e.label === c.label || e.sourceHandle.includes(c.when.slot))
      )
      return {
        when: c.when,          // 完整条件结构 {slot, op, value}
        next: edge ? ... : null,
        label: c.label || '',
      }
    })
  }
  
  // 回退：从连线中推断（兼容旧格式）
  ...
}
```

**✅ 验证点：**
- [x] 优先读取节点 data.cases 中的配置
- [x] 保留完整的 when 结构（slot/op/value）
- [x] 根据条件标签或变量名匹配对应的连线
- [x] 向后兼容旧格式（从连线推断）

---

### 3. DSL 数据格式

**预期输出结构：**
```json
{
  "key": "branch_001",
  "type": "branch",
  "cases": [
    {
      "label": "成年",
      "when": {
        "slot": "age",
        "op": "gt",
        "value": "18"
      },
      "next": "step_adult"
    },
    {
      "label": "未成年",
      "when": {
        "slot": "age",
        "op": "lte",
        "value": "18"
      },
      "next": "step_minor"
    }
  ]
}
```

**✅ 验证点：**
- [x] cases 数组包含所有分支条件
- [x] 每个 case 有 label、when、next 字段
- [x] when 对象包含 slot、op、value 三个字段

---

## 🧪 手动测试步骤

由于浏览器自动化测试遇到问题，请按照以下步骤手动测试：

### 测试1：UI 显示验证

1. 打开 http://localhost:3001/admin/
2. 登录并进入任务流程编辑器
3. 拖拽一个"分支"节点到画布
4. 单击节点打开属性面板
5. **检查点**：
   - ✅ 是否显示"分支条件"区域
   - ✅ 是否有"+ 添加条件"按钮
   - ✅ 点击后是否出现一行包含4个控件的配置项

### 测试2：条件配置验证

1. 点击"+ 添加条件"
2. 配置第一个条件：
   - 条件标签：成年
   - 变量：age
   - 运算符：大于
   - 值：18
3. **检查点**：
   - ✅ 所有字段都能正常输入/选择
   - ✅ 运算符下拉有9个选项
   - ✅ 值输入框正常工作

4. 再次点击"+ 添加条件"
5. 配置第二个条件：
   - 条件标签：未成年
   - 变量：age
   - 运算符：小于等于
   - 值：18
6. **检查点**：
   - ✅ 可以添加多个条件
   - ✅ 每个条件独立配置

### 测试3：特殊运算符验证

1. 添加第三个条件
2. 运算符选择"为空"
3. **检查点**：
   - ✅ 值输入框应该被禁用（灰色）
   - ✅ 无法在值输入框中输入内容

4. 运算符改为"不为空"
5. **检查点**：
   - ✅ 值输入框仍然禁用

6. 运算符改回"等于"
7. **检查点**：
   - ✅ 值输入框恢复可用

### 测试4：保存验证

1. 配置好分支条件后
2. 点击右上角"保存"按钮
3. 按 F12 打开浏览器控制台
4. **检查点**：
   - ✅ 看到 `[DEBUG handleSave]` 日志
   - ✅ 看到 `steps count: X`（X > 0）
   - ✅ 展开 steps 数组，找到 branch 类型的 step
   - ✅ 检查 cases 数组是否包含完整的 when 结构

**预期日志示例：**
```
[DEBUG handleSave] nodes count: 5
[DEBUG handleSave] edges count: 4
[DEBUG handleSave] steps count: 5
[DEBUG handleSave] steps: [
  {
    "key": "branch_001",
    "type": "branch",
    "cases": [
      {
        "label": "成年",
        "when": {
          "slot": "age",
          "op": "gt",
          "value": "18"
        },
        "next": "step_adult"
      },
      {
        "label": "未成年",
        "when": {
          "slot": "age",
          "op": "lte",
          "value": "18"
        },
        "next": "step_minor"
      }
    ]
  }
]
```

### 测试5：加载验证

1. 保存成功后返回列表
2. 重新点击"画布编辑"进入刚才的任务
3. 单击分支节点
4. **检查点**：
   - ✅ 之前配置的条件应该都还在
   - ✅ 变量、运算符、值都正确显示

### 测试6：聊天测试（端到端）

**前提条件**：需要配置收集节点获取 age 变量

1. 创建完整流程：开始 → 收集(age) → 分支 → 回复(成年/未成年) → 结束
2. 配置触发词（如"测试年龄"）
3. 保存流程

**对话1（成年人）：**
- 用户输入："测试年龄"
- 系统回复："请输入您的年龄"
- 用户输入："25"
- **预期**：系统回复"您已成年，可以办理相关业务"

**对话2（未成年人）：**
- 用户输入："测试年龄"
- 系统回复："请输入您的年龄"
- 用户输入："15"
- **预期**：系统回复"您未满18岁，需要监护人陪同"

---

## 🔍 问题排查

### 如果 UI 不显示

1. 检查浏览器控制台是否有 JavaScript 错误
2. 检查 NodePanel.vue 是否正确编译
3. 检查 Docker 容器是否重启成功

### 如果保存失败

1. 查看控制台 `[DEBUG handleSave]` 日志
2. 检查 steps 数组是否为空
3. 检查 branch 节点的 cases 是否有 when 结构
4. 记录完整的错误响应

### 如果加载后数据丢失

1. 检查 flowConverter.js 的 dslToCanvas 函数
2. 确认 data.variableName 和 data.cases 是否正确映射
3. 查看后端返回的 task 数据中 steps 是否正确

---

## 📊 测试结果记录

| 测试项 | 预期结果 | 实际结果 | 状态 | 备注 |
|--------|----------|----------|------|------|
| UI 显示 | 显示分支条件配置区 |  | ⏳ |  |
| 条件标签输入 | 可输入文本 |  | ⏳ |  |
| 变量选择 | 下拉可选4个变量 |  |  |  |
| 运算符选择 | 下拉可选9种运算符 |  |  |  |
| 值输入 | 可输入文本/数字 |  | ⏳ |  |
| 禁用逻辑 | '为空/不为空'时禁用值输入 |  | ⏳ |  |
| 添加条件 | 可添加多个条件 |  |  |  |
| 删除条件 | 可删除单个条件 |  | ⏳ |  |
| 保存成功 | 控制台有 DEBUG 日志 |  | ⏳ |  |
| DSL 结构 | cases 包含完整 when |  | ⏳ |  |
| 加载恢复 | 条件配置都保留 |  | ⏳ |  |
| 聊天分支 | 根据年龄走不同分支 |  | ⏳ |  |

---

## 🎯 关键验证点总结

1. **UI 完整性**：4个字段（标签、变量、运算符、值）都能正常配置
2. **数据结构**：保存后 cases 包含 `{label, when: {slot, op, value}, next}`
3. **向后兼容**：旧格式（从连线推断）仍能正常工作
4. **端到端**：聊天时能根据条件走不同分支

请完成上述测试并填写结果表格！
