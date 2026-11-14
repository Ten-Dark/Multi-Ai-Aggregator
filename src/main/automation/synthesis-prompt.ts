import { MODEL_LABELS, type ModelId, type SynthesisAnswer } from '../../shared/types.js'

export const SYNTHESIS_INSTRUCTION = `Ты — независимый аналитик. Тебе предоставлены исходный запрос и три независимых ответа от разных AI-моделей.

Твоя задача:
- Объединить полезную информацию.
- Устранить повторения.
- Выявить противоречия.
- Отделить подтверждённые факты от предположений.
- Не придумывать отсутствующую информацию.
- Не скрывать существенные разногласия между моделями.
- Сохранить важные детали и практические рекомендации.
- Убрать лишние рассуждения и сделать результат компактным.

Подготовь один цельный, информативный, структурированный и достоверный ответ, непосредственно отвечающий на исходный запрос.`

const MAX_ANSWER_CHARS = 30000

function truncate(text: string, limit = MAX_ANSWER_CHARS): string {
  const clean = text.trim()
  if (clean.length <= limit) return clean
  return `${clean.slice(0, limit)}\n\n[…фрагмент ответа сокращён из-за длины]`
}

export function buildSynthesisPrompt(
  originalPrompt: string,
  answers: SynthesisAnswer[],
): string {
  const byModel = new Map<ModelId, SynthesisAnswer>()
  for (const answer of answers) byModel.set(answer.model, answer)

  const order: ModelId[] = ['chatgpt', 'qwen', 'deepseek']
  const missing = order.filter((model) => !byModel.get(model)?.text?.trim())

  const answerBlocks = order.map((model) => {
    const answer = byModel.get(model)
    const text = answer?.text?.trim()
    const body = text
      ? truncate(text)
      : `[ОТВЕТ НЕ ПОЛУЧЕН: ${answer?.error?.trim() || 'модель не ответила'}]`
    return `<answer model="${MODEL_LABELS[model]}">\n${body}\n</answer>`
  })

  const missingNote =
    missing.length > 0
      ? '\n- Одна или несколько моделей не предоставили ответ. Не выдумывай информацию за них и явно учитывай это в итоговом ответе.'
      : ''

  return `${SYNTHESIS_INSTRUCTION}

Правила оформления:
- Ответь на языке исходного запроса.
- Не добавляй вступление о процессе анализа ответов моделей.
- Сохраняй структуру и практическую пользу итогового ответа.${missingNote}

ИСХОДНЫЙ ЗАПРОС:
<original_request>
${originalPrompt.trim()}
</original_request>

ОТВЕТЫ МОДЕЛЕЙ:
<model_answers>
${answerBlocks.join('\n\n')}
</model_answers>`
}
