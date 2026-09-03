/**
 * 模型对比测试脚本
 * 
 * 用实际 FAQ 数据评估 3 个候选模型的匹配效果
 * 
 * 测试维度：
 * 1. 匹配准确率（正确 FAQ 排第一的比例）
 * 2. Top-3 命中率（正确 FAQ 在前3的比例）
 * 3. 区分度（正确匹配与次优匹配的分数差）
 * 4. 推理速度（单条编码耗时）
 * 
 * 用法: node scripts/benchmark-models.js
 */
import 'dotenv/config'
import NLPEngine from '../src/nlpEngine.js'
import { cosineSimilarity } from '../src/similarity.js'
import pool from '../db/pool.js'

const MODELS = [
  'paraphrase-multilingual-MiniLM-L12-v2',
  'bge-base-zh-v1.5',
  'bge-small-zh-v1.5',
]

// 测试用例：模拟真实用户提问 → 期望命中的 FAQ code
const TEST_CASES = [
  // 问候类
  { query: '你好', expected: 'greeting' },
  { query: '在吗', expected: 'greeting' },
  { query: 'hello', expected: 'greeting' },
  { query: '嗨', expected: 'greeting' },
  
  // 业务咨询类
  { query: '你们怎么收费', expected: null },  // null = 只要命中任一FAQ即可
  { query: '多少钱', expected: null },
  { query: '价格是多少', expected: null },
  
  // 短文本（考验模型对短句的理解）
  { query: '报修', expected: null },
  { query: '投诉', expected: null },
  { query: '取消', expected: null },
  
  // 口语化表达
  { query: '我想问一下怎么办', expected: null },
  { query: '能不能帮我看看', expected: null },
  { query: '这个怎么弄', expected: null },
  
  // 无意义输入（应该低分）
  { query: 'asdfghjkl', expected: '__meaningless__' },
  { query: '啊啊啊啊', expected: '__meaningless__' },
]

async function loadFaqData() {
  const [faqs] = await pool.execute('SELECT code, name, answer FROM faq')
  const [questions] = await pool.execute('SELECT faq_code, question FROM faq_question WHERE is_regex = 0')
  
  // 按 faq_code 聚合相似问
  const questionMap = new Map()
  for (const q of questions) {
    if (!questionMap.has(q.faq_code)) questionMap.set(q.faq_code, [])
    questionMap.get(q.faq_code).push(q.question)
  }
  
  return faqs.map(f => ({
    code: f.code,
    name: f.name,
    samples: questionMap.get(f.code) || [],
    answer: f.answer,
  })).filter(f => f.samples.length > 0)
}

async function benchmarkModel(modelName, faqList) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`模型: ${modelName}`)
  console.log('='.repeat(60))
  
  const engine = new NLPEngine(modelName)
  
  // 1. 加载模型 + 计时
  const loadStart = Date.now()
  await engine.getModel()
  const loadTime = Date.now() - loadStart
  console.log(`  模型加载: ${loadTime}ms`)
  
  // 2. 编码所有 FAQ 样本
  const allSamples = []
  const sampleToCode = []
  for (const faq of faqList) {
    for (const sample of faq.samples) {
      allSamples.push(sample)
      sampleToCode.push(faq.code)
    }
  }
  console.log(`  FAQ样本数: ${allSamples.length}`)
  
  const encodeStart = Date.now()
  const sampleVectors = await engine.encodeTexts(allSamples)
  const encodeTime = Date.now() - encodeStart
  const avgEncodeMs = (encodeTime / allSamples.length).toFixed(1)
  console.log(`  样本编码: ${encodeTime}ms (平均 ${avgEncodeMs}ms/条)`)
  
  // 3. 测试匹配
  let correct = 0
  let top3Hit = 0
  let totalTested = 0
  let totalQueryTime = 0
  const gaps = []
  const meaninglessScores = []
  
  for (const tc of TEST_CASES) {
    const qStart = Date.now()
    const queryVec = await engine.encodeQuery(tc.query)
    totalQueryTime += Date.now() - qStart
    
    // 计算与所有样本的相似度，取每个FAQ的最高分
    const faqScores = new Map()
    for (let i = 0; i < allSamples.length; i++) {
      const sim = cosineSimilarity(queryVec, sampleVectors[i])
      const code = sampleToCode[i]
      if (!faqScores.has(code) || faqScores.get(code) < sim) {
        faqScores.set(code, sim)
      }
    }
    
    // 排序
    const sorted = [...faqScores.entries()]
      .map(([code, score]) => ({ code, score }))
      .sort((a, b) => b.score - a.score)
    
    const top1 = sorted[0]
    const top2 = sorted[1]
    const top3 = sorted[2]
    
    if (tc.expected === '__meaningless__') {
      // 无意义输入：期望最高分也很低
      meaninglessScores.push({ query: tc.query, topScore: top1?.score || 0, topCode: top1?.code })
      continue
    }
    
    totalTested++
    
    if (tc.expected) {
      // 有明确期望
      if (top1.code === tc.expected) {
        correct++
      }
      if (sorted.slice(0, 3).some(s => s.code === tc.expected)) {
        top3Hit++
      }
    } else {
      // 无明确期望：只要匹配到某个FAQ就算命中
      if (top1 && top1.score > 0.3) {
        correct++
      }
      if (sorted.slice(0, 3).some(s => s.score > 0.3)) {
        top3Hit++
      }
    }
    
    // 区分度
    if (top1 && top2) {
      gaps.push(top1.score - top2.score)
    }
  }
  
  const avgQueryMs = (totalQueryTime / TEST_CASES.length).toFixed(1)
  const avgGap = gaps.length ? (gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(3) : 'N/A'
  const minGap = gaps.length ? Math.min(...gaps).toFixed(3) : 'N/A'
  
  // 4. 输出结果
  console.log(`\n  --- 匹配结果 ---`)
  console.log(`  测试用例: ${TEST_CASES.length} 条 (含 ${meaninglessScores.length} 条无意义)`)
  console.log(`  Top-1 命中: ${correct}/${totalTested} (${(correct/totalTested*100).toFixed(1)}%)`)
  console.log(`  Top-3 命中: ${top3Hit}/${totalTested} (${(top3Hit/totalTested*100).toFixed(1)}%)`)
  console.log(`  平均区分度: ${avgGap}`)
  console.log(`  最小区分度: ${minGap}`)
  console.log(`  查询速度: 平均 ${avgQueryMs}ms/条`)
  console.log(`  向量维度: ${sampleVectors[0].length}`)
  
  // 无意义输入检测
  console.log(`\n  --- 无意义输入检测 ---`)
  for (const ms of meaninglessScores) {
    const status = ms.topScore < 0.5 ? '✅ 低分' : '⚠️ 高分'
    console.log(`  "${ms.query}" → ${ms.topScore.toFixed(3)} (${ms.topCode}) ${status}`)
  }
  
  return {
    model: modelName,
    loadTime,
    encodeTime,
    avgEncodeMs: parseFloat(avgEncodeMs),
    avgQueryMs: parseFloat(avgQueryMs),
    top1Acc: correct / totalTested,
    top3Acc: top3Hit / totalTested,
    avgGap: parseFloat(avgGap) || 0,
    minGap: parseFloat(minGap) || 0,
    dim: sampleVectors[0].length,
    meaninglessMax: Math.max(...meaninglessScores.map(m => m.topScore)),
  }
}

async function main() {
  console.log('🔬 模型对比测试')
  console.log(`   候选模型: ${MODELS.join(', ')}`)
  
  // 加载 FAQ 数据
  const faqList = await loadFaqData()
  console.log(`   FAQ 条目: ${faqList.length}`)
  console.log(`   测试用例: ${TEST_CASES.length}`)
  
  const results = []
  
  for (const modelName of MODELS) {
    try {
      const result = await benchmarkModel(modelName, faqList)
      results.push(result)
    } catch (e) {
      console.error(`\n❌ ${modelName} 测试失败:`, e.message)
      results.push({ model: modelName, error: e.message })
    }
  }
  
  // 汇总对比
  console.log(`\n\n${'='.repeat(60)}`)
  console.log('📊 模型对比汇总')
  console.log('='.repeat(60))
  
  const validResults = results.filter(r => !r.error)
  
  if (validResults.length === 0) {
    console.log('所有模型测试失败')
    await pool.end()
    return
  }
  
  // 找最优
  const bestAcc = validResults.reduce((a, b) => a.top1Acc > b.top1Acc ? a : b)
  const bestSpeed = validResults.reduce((a, b) => a.avgQueryMs < b.avgQueryMs ? a : b)
  const bestGap = validResults.reduce((a, b) => a.avgGap > b.avgGap ? a : b)
  const bestMeaningless = validResults.reduce((a, b) => a.meaninglessMax < b.meaninglessMax ? a : b)
  
  console.log(`\n  ${'模型'.padEnd(40)} ${'Top-1'.padStart(8)} ${'Top-3'.padStart(8)} ${'区分度'.padStart(8)} ${'速度ms'.padStart(8)} ${'维度'.padStart(6)}`)
  console.log('  ' + '-'.repeat(80))
  
  for (const r of validResults) {
    const name = r.model.padEnd(40)
    const acc = (r.top1Acc * 100).toFixed(1).padStart(7) + '%'
    const top3 = (r.top3Acc * 100).toFixed(1).padStart(7) + '%'
    const gap = r.avgGap.toFixed(3).padStart(8)
    const speed = r.avgQueryMs.toFixed(1).padStart(8)
    const dim = String(r.dim).padStart(6)
    console.log(`  ${name} ${acc} ${top3} ${gap} ${speed} ${dim}`)
  }
  
  console.log(`\n  🏆 最佳准确率: ${bestAcc.model}`)
  console.log(`  🏆 最快速度:   ${bestSpeed.model} (${bestSpeed.avgQueryMs}ms)`)
  console.log(`  🏆 最佳区分度: ${bestGap.model} (${bestGap.avgGap})`)
  console.log(`  🏆 无意义过滤: ${bestMeaningless.model} (最高分 ${bestMeaningless.meaninglessMax.toFixed(3)})`)
  
  // 综合推荐
  console.log(`\n  💡 综合推荐:`)
  // 计算综合得分（准确率权重0.4 + 区分度0.3 + 速度0.2 + 无意义过滤0.1）
  for (const r of validResults) {
    const score = r.top1Acc * 0.4 + r.avgGap * 2 * 0.3 + (1 - r.avgQueryMs / 500) * 0.2 + (1 - r.meaninglessMax) * 0.1
    r.compositeScore = score
  }
  const bestOverall = validResults.reduce((a, b) => a.compositeScore > b.compositeScore ? a : b)
  console.log(`  推荐使用: ${bestOverall.model}`)
  console.log(`  综合得分: ${bestOverall.compositeScore.toFixed(3)}`)
  
  await pool.end()
}

main().catch(e => { console.error('测试异常:', e); process.exit(1) })
