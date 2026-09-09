/**
 * 画布 ↔ DSL 双向转换器
 *
 * canvas 格式（Vue Flow）：
 *   nodes: [{ id, type, position, data }]
 *   edges: [{ id, source, target, sourceHandle?, label? }]
 *
 * DSL 格式（后端 steps）：
 *   [{ key, type, next, slot_key, prompt, ... }]
 *
 * 转换规则：
 *   - 节点 type 映射 DSL step.type
 *   - 节点 data 映射 step 的其余字段
 *   - 边（source→target）映射 step.next
 *   - 分支节点的多个出口（sourceHandle）映射 branch.cases
 */

import dagre from 'dagre'

// ========== 节点类型定义 ==========

export const NODE_TYPES = {
  start:    { label: '开始',   color: '#52c41a', icon: '▶' },
  collect:  { label: '收集',   color: '#1890ff', icon: '📥' },
  message:  { label: '回复',   color: '#722ed1', icon: '💬' },
  branch:   { label: '分支',   color: '#fa8c16', icon: '🔀' },
  api:      { label: '接口',   color: '#eb2f96', icon: '🔗' },
  confirm:  { label: '确认',   color: '#13c2c2', icon: '✅' },
  subtask:  { label: '子任务', color: '#8c8c8c', icon: '📋' },
  end:      { label: '结束',   color: '#f5222d', icon: '⏹' },
}

// ========== DSL → Canvas ==========

/**
 * 将后端 steps DSL 转换为 Vue Flow 的 nodes/edges
 * @param {Array} steps - 后端 steps JSON
 * @param {Object} flowCanvas - 保存的画布布局（可选）
 * @returns {{ nodes: Array, edges: Array }}
 */
export function dslToCanvas(steps, flowCanvas) {
  if (!steps || !Array.isArray(steps) || steps.length === 0) {
    return { nodes: [], edges: [] }
  }

  // 如果有保存的布局，直接恢复
  if (flowCanvas && flowCanvas.nodes && flowCanvas.nodes.length > 0) {
    return {
      nodes: flowCanvas.nodes,
      edges: flowCanvas.edges || [],
    }
  }

  // 无保存布局 → dagre 自动排列
  return dagreLayout(steps)
}

/**
 * 用 dagre 对有向图做自动布局
 */
function dagreLayout(steps) {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'TB', nodesep: 120, ranksep: 100, marginx: 60, marginy: 60 })

  const nodeWidth = 140
  const nodeHeight = 44

  // 添加节点
  for (const step of steps) {
    g.setNode(step.key, { width: nodeWidth, height: nodeHeight })
  }

  // 添加边
  for (const step of steps) {
    if (step.next) {
      g.setEdge(step.key, step.next)
    }
    // 分支节点的多路出口
    if (step.type === 'branch' && Array.isArray(step.cases)) {
      for (const c of step.cases) {
        if (c.next) g.setEdge(step.key, c.next, { label: c.label || '' })
      }
    }
  }

  dagre.layout(g)

  const nodes = steps.map(step => {
    const pos = g.node(step.key)
    return {
      id: `node_${step.key}`,
      type: mapStepTypeToNodeType(step.type),
      position: { x: pos.x - nodeWidth / 2, y: pos.y - nodeHeight / 2 },
      data: {
        key: step.key,
        label: step.label || getStepLabel(step),
        ...extractNodeData(step),
      },
    }
  })

  const edges = []
  for (const step of steps) {
    if (step.next) {
      edges.push({
        id: `edge_${step.key}_${step.next}`,
        source: `node_${step.key}`,
        target: `node_${step.next}`,
      })
    }
    if (step.type === 'branch' && Array.isArray(step.cases)) {
      for (const c of step.cases) {
        if (c.next) {
          edges.push({
            id: `edge_${step.key}_${c.next}`,
            source: `node_${step.key}`,
            target: `node_${c.next}`,
            label: c.label || '',
          })
        }
      }
    }
  }

  return { nodes, edges }
}

// ========== Canvas → DSL ==========

/**
 * 将 Vue Flow 的 nodes/edges 转换为后端 steps DSL
 * @param {Array} nodes
 * @param {Array} edges
 * @returns {{ steps: Array, flowCanvas: Object }}
 */
export function canvasToDSL(nodes, edges) {
  const steps = []
  const nodeMap = new Map(nodes.map(n => [n.id, n]))

  for (const node of nodes) {
    const d = node.data || {}
    const step = {
      key: d.key || node.id.replace('node_', ''),
      type: mapNodeTypeToStepType(node.type),
    }

    // 主出口（非分支节点的 next）
    const mainEdge = edges.find(e => e.source === node.id && !e.sourceHandle)
    if (mainEdge) {
      const targetNode = nodeMap.get(mainEdge.target)
      step.next = targetNode?.data?.key || mainEdge.target.replace('node_', '')
    }

    // 各类型特有字段
    switch (node.type) {
      case 'collect':
        step.slot_key = d.slotKey || ''
        step.prompt = d.prompt || ''
        step.label = d.label || ''
        break
      case 'message':
        step.text = d.text || ''
        break
      case 'branch':
        step.cases = buildBranchCases(node, edges, nodeMap)
        step.default_next = d.defaultNext || null
        break
      case 'api':
        step.url = d.url || ''
        step.method = d.method || 'POST'
        step.fieldMap = d.fieldMap || {}
        step.resultMap = d.resultMap || {}
        step.message = d.message || ''
        break
      case 'confirm':
        step.prompt = d.prompt || ''
        break
      case 'subtask':
        step.task = d.task || ''
        step.on_return = d.onReturn || null
        break
      case 'end':
        step.action = 'complete_message'
        step.done_message = d.doneMessage || ''
        break
    }

    steps.push(step)
  }

  // 保存画布布局
  const flowCanvas = {
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: nodes.map(n => ({
      id: n.id,
      type: n.type,
      position: n.position,
      data: n.data,
    })),
    edges: edges.map(e => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle || undefined,
      label: e.label || undefined,
    })),
  }

  return { steps, flowCanvas }
}

/** 构建分支节点的条件出口 */
function buildBranchCases(node, edges, nodeMap) {
  const branchEdges = edges.filter(e => e.source === node.id && e.sourceHandle)
  return branchEdges.map(e => {
    const targetNode = nodeMap.get(e.target)
    return {
      when: { slot: e.sourceHandle, op: 'eq', value: e.label || '' },
      next: targetNode?.data?.key || e.target.replace('node_', ''),
      label: e.label || '',
    }
  })
}

// ========== 工具函数 ==========

function mapStepTypeToNodeType(type) {
  const map = {
    collect: 'collect',
    message: 'message',
    branch: 'branch',
    api: 'api',
    confirm: 'confirm',
    subtask: 'subtask',
    action: 'end',
  }
  return map[type] || 'message'
}

function mapNodeTypeToStepType(nodeType) {
  const map = {
    start: 'message',
    collect: 'collect',
    message: 'message',
    branch: 'branch',
    api: 'api',
    confirm: 'confirm',
    subtask: 'subtask',
    end: 'action',
  }
  return map[nodeType] || 'message'
}

function getStepLabel(step) {
  const typeLabels = {
    collect: step.slot_key || step.label || '收集',
    message: step.text || '回复',
    branch: '分支',
    api: step.url || '接口',
    confirm: '确认',
    subtask: step.task || '子任务',
    action: step.done_message || '完成',
  }
  return typeLabels[step.type] || step.type
}

function extractNodeData(step) {
  const data = {}
  switch (step.type) {
    case 'collect':
      data.slotKey = step.slot_key
      data.prompt = step.prompt
      data.label = step.label
      break
    case 'message':
      data.text = step.text
      break
    case 'branch':
      data.cases = step.cases
      data.defaultNext = step.default_next
      break
    case 'api':
      data.url = step.url
      data.method = step.method
      data.fieldMap = step.fieldMap
      data.resultMap = step.resultMap
      data.message = step.message
      break
    case 'confirm':
      data.prompt = step.prompt
      break
    case 'subtask':
      data.task = step.task
      data.onReturn = step.on_return
      break
    case 'action':
      data.doneMessage = step.done_message
      break
  }
  return data
}

/** 生成唯一节点 key */
export function generateKey(prefix, existingKeys) {
  let key = prefix
  let counter = 1
  while (existingKeys.has(key)) {
    key = `${prefix}_${counter++}`
  }
  return key
}
