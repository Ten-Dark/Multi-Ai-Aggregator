import { app, clipboard, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { MODEL_IDS, type ModelId, type SynthesisRequest } from '../shared/types.js'
import { getMainWindow } from './window.js'
import type { ZenBridge } from './zen/bridge.js'

const MAX_PROMPT_CHARS = 300_000
const MAX_COPY_CHARS = 2_000_000
const MAX_SYNTHESIS_INPUT_CHARS = 280_000
const MAX_SYNTHESIS_ANSWERS = 3
const MAX_SYNTHESIS_ERROR_CHARS = 2_000

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const window = getMainWindow()
  const frame = event.senderFrame

  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    !frame ||
    frame.parent !== null ||

    frame.url !== window.webContents.getURL()
  ) {
    throw new Error('Недоверенный источник IPC-вызова.')
  }

  let url: URL
  try {
    url = new URL(frame.url)
  } catch {
    throw new Error('Некорректный адрес IPC-источника.')
  }

  if (app.isPackaged) {
    if (url.protocol !== 'file:') {
      throw new Error('В production разрешён только локальный renderer.')
    }
    return
  }

  if (
    url.protocol !== 'http:' ||
    url.hostname !== 'localhost' ||
    url.port !== '5173' ||
    url.pathname !== '/'
  ) {
    throw new Error('IPC-вызов из недоверенного development renderer.')
  }
}

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

  const request = value as Record<string, unknown>
  assertModel(request.model)
  assertPrompt(request.prompt)

  if (!Array.isArray(request.answers) || request.answers.length === 0) {
    throw new Error('Не переданы ответы для синтеза.')
  }
  if (request.answers.length > MAX_SYNTHESIS_ANSWERS) {
    throw new Error('Слишком много ответов для синтеза.')
  }

  const seenModels = new Set<ModelId>()
  let totalChars = request.prompt.length
  const answers = request.answers.map((rawAnswer) => {
    if (!rawAnswer || typeof rawAnswer !== 'object') {
      throw new Error('Некорректный ответ модели.')
    }

    const answer = rawAnswer as Record<string, unknown>
    assertModel(answer.model)
    if (seenModels.has(answer.model)) throw new Error('Повторяющаяся модель в ответах.')
    seenModels.add(answer.model)

    if (answer.text !== undefined && typeof answer.text !== 'string') {
      throw new Error('Некорректный текст ответа.')
    }
    if (answer.error !== undefined && typeof answer.error !== 'string') {
      throw new Error('Некорректное описание ошибки.')
    }
    if (typeof answer.error === 'string' && answer.error.length > MAX_SYNTHESIS_ERROR_CHARS) {
      throw new Error('Описание ошибки модели слишком длинное.')
    }

    totalChars += (typeof answer.text === 'string' ? answer.text.length : 0)
    totalChars += (typeof answer.error === 'string' ? answer.error.length : 0)

    return {
      model: answer.model,
      text: answer.text as string | undefined,
      error: answer.error as string | undefined,
    }
  })

  if (totalChars > MAX_SYNTHESIS_INPUT_CHARS) {
    throw new Error('Суммарный объём данных для синтеза слишком велик.')
  }

  return { model: request.model, prompt: request.prompt, answers }
}

export function registerAggregatorIpc(getBridge: () => ZenBridge): void {
  ipcMain.handle('aggregator:getBrowserInfo', async (event) => {
    assertTrustedSender(event)
    return getBridge().getBrowserInfo()
  })

  ipcMain.handle('aggregator:getZenConnection', async (event) => {
    assertTrustedSender(event)
    return getBridge().getZenConnection()
  })

  ipcMain.handle('aggregator:launchBrowser', async (event) => {
    assertTrustedSender(event)
    return getBridge().openBrowser()
  })

  ipcMain.handle('aggregator:checkSessions', async (event) => {
    assertTrustedSender(event)
    return getBridge().checkSessions()
  })

  ipcMain.handle('aggregator:focusModel', async (event, model: unknown) => {
    assertTrustedSender(event)
    assertModel(model)
    await getBridge().focusModel(model)
  })

  ipcMain.handle('aggregator:sendAll', async (event, prompt: unknown) => {
    assertTrustedSender(event)
    assertPrompt(prompt)
    return getBridge().sendAll(prompt)
  })

  ipcMain.handle('aggregator:sendOne', async (event, model: unknown, prompt: unknown) => {
    assertTrustedSender(event)
    assertModel(model)
    assertPrompt(prompt)
    return getBridge().sendOne(model, prompt)
  })

  ipcMain.handle('aggregator:synthesize', async (event, request: unknown) => {
    assertTrustedSender(event)
    return getBridge().synthesize(validateSynthesisRequest(request))
  })

  ipcMain.handle('aggregator:copyText', async (event, text: unknown) => {
    assertTrustedSender(event)
    if (typeof text !== 'string') throw new Error('Некорректный текст для копирования.')
    clipboard.writeText(text.slice(0, MAX_COPY_CHARS))
  })

  ipcMain.handle('app:getVersion', async (event) => {
    assertTrustedSender(event)
    return app.getVersion()
  })
}
