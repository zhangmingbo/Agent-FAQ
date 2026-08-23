/**
 * 统计与分析领域服务
 *
 * 职责：聚合 chat_log / faq 的统计查询，为监控概览与智能分析接口提供数据。
 * 全部通过 repositories 访问数据库，不直接写 SQL。
 */

import * as chatLogRepo from '../repositories/chatLogRepo.js'
import * as faqRepo from '../repositories/faqRepo.js'

/**
 * 服务概览统计（监控首页）
 */
export function getStats() {
  return chatLogRepo.getServiceStats()
}

/**
 * 智能分析报告（分析页）
 *
 * 原 FAQEngine.getAnalysis() 的 SQL 实现收敛于此，
 * 由 chatLogRepo / faqRepo 的既有查询聚合而成。
 */
export async function getAnalysis(maxConfidence = 0.7) {
  const [unmatched, lowConfidence, topQuestions, trend, meaningless, coverageStats, lowQuestionFaqs] = await Promise.all([
    chatLogRepo.getUnmatchedForAnalysis(),
    chatLogRepo.getLowConfidenceForAnalysis(maxConfidence),
    chatLogRepo.getTopQuestions(),
    chatLogRepo.getTrend(),
    chatLogRepo.getFallbackStats(),
    faqRepo.getStats(),
    faqRepo.getLowQuestionFaqs(),
  ])

  const { totalFaq, withAnswer, withRichContent, withRelated } = coverageStats
  const safeTotal = totalFaq || 1 // 防止除零

  return {
    unmatched,
    lowConfidence,
    topQuestions,
    coverage: {
      totalFaq,
      withAnswer,
      withRichContent,
      withRelated,
      answerRate: ((withAnswer / safeTotal) * 100).toFixed(1),
      richRate: ((withRichContent / safeTotal) * 100).toFixed(1),
      relatedRate: ((withRelated / safeTotal) * 100).toFixed(1),
      lowQuestionFaqs,
    },
    trend,
    meaningless,
  }
}
