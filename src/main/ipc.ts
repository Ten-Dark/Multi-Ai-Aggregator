import { app, clipboard, ipcMain } from 'electron'
import { MODEL_IDS, type ModelId, type SynthesisRequest } from '../shared/types.js'
import type { ZenBridge } from './zen/bridge.js'

const MAX_PROMPT_CHARS = 300_000
const MAX_COPY_CHARS = 2_000_000

function assertModel(value: unknown): asserts value is ModelId {
  if (typeof value !== 'string' || !MODEL_IDS.includes(value as ModelId)) {
    throw new Error('Неизвестная модель.')
  }
}

function assertPrompt(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Запрос пуст.')
  }
  if (value.length > MAX_PROMPT_CHARS) {
    throw new Error(`Запрос слишком длинный (максимум ${MAX_PROMPT_CHARS.toLocaleString('ru-RU')} символов).`)
  }
}

function validateSynthesisRequest(value: unknown): SynthesisRequest {
  if (!value || typeof value !== 'object') throw new Error('Некорректный запрос синтеза.')
  const request = value as SynthesisRequest
  assertModel(request.model)
  assertPrompt(request.prompt)
  if (!Array.isArray(request.answers)) throw new Error('Не переданы ответы для синтеза.')
  const answers = request.answers
    .filter((answer) => answer && typeof answer === 'object')
    .map((answer) => {
      assertModel(answer.model)
      if (answer.text !== undefined && typeof answer.text !== 'string') {
        throw new Error('Некорректный текст ответа.')
      }
      if (answer.error !== undefined && typeof answer.error !== 'string') {
        throw new Error('Некорректное описание ошибки.')
      }
      return {
        model: answer.model,
        text: answer.text,
        error: answer.error,
      }
    })
  return { model: request.model, prompt: request.prompt, answers }
}

export function registerAggregatorIpc(getBridge: () => ZenBridge): void {
  ipcMain.handle('aggregator:getBrowserInfo', async () => getBridge().getBrowserInfo())

  ipcMain.handle('aggregator:getZenConnection', async () => getBridge().getZenConnection())

  ipcMain.handle('aggregator:launchBrowser', async () => getBridge().openBrowser())

  ipcMain.handle('aggregator:checkSessions', async () => getBridge().checkSessions())

  ipcMain.handle('aggregator:focusModel', async (_event, model: unknown) => {
    assertModel(model)
    await getBridge().focusModel(model)
  })

  ipcMain.handle('aggregator:sendAll', async (_event, prompt: unknown) => {
    assertPrompt(prompt)
    return getBridge().sendAll(prompt)
  })

  ipcMain.handle('aggregator:sendOne', async (_event, model: unknown, prompt: unknown) => {
    assertModel(model)
    assertPrompt(prompt)
    return getBridge().sendOne(model, prompt)
  })

  ipcMain.handle('aggregator:synthesize', async (_event, request: unknown) => {
    return getBridge().synthesize(validateSynthesisRequest(request))
  })

  ipcMain.handle('aggregator:copyText', async (_event, text: unknown) => {
    if (typeof text !== 'string') throw new Error('Некорректный текст для копирования.')
    clipboard.writeText(text.slice(0, MAX_COPY_CHARS))
  })

  ipcMain.handle('app:getVersion', async () => app.getVersion())
}
