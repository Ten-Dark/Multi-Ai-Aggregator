import type { ModelId } from '../../shared/types.js'

export type CompletionMode = 'attribute' | 'stable'

export interface SiteAdapter {
  id: ModelId
  label: string
  url: string
  composerSelectors: string[]
  sendSelectors: string[]
  assistantSelectors: string[]
  contentSelectors: string[]
  stopSelectors: string[]
  loggedOutSelectors: string[]
  loginPageUrlPatterns: RegExp[]
  loginFormSelectors: string[]
  completion: CompletionMode
  completeAttribute?: string
  stableMs: number
  guestAllowed: boolean
}

export const ADAPTERS: Record<ModelId, SiteAdapter> = {
  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT',
    url: 'https://chatgpt.com/',
    composerSelectors: [
      '#prompt-textarea',
      'textarea#mobile-composer-prompt',
      'textarea[name="prompt"]',
      'div.ProseMirror[contenteditable="true"]',
      '[contenteditable="true"][data-lexical-editor="true"]',
    ],
    sendSelectors: [
      'button[aria-label*="Отправить" i]',
      'button[aria-label*="Send" i]',
      'button[data-testid="send-button"]',
      'button[data-testid="composer-send-button"]',
      'button[type="submit"]',
    ],
    assistantSelectors: [
      'li[data-message-role="assistant"]',
      '[data-message-author-role="assistant"]',
    ],
    contentSelectors: [
      '[data-assistant-markdown]',
      '.markdown.prose',
      '.markdown',
    ],
    stopSelectors: [
      'button[aria-label*="Перестать" i]',
      'button[aria-label*="Stop" i]',
      'button[data-testid="stop-button"]',
    ],
    loggedOutSelectors: [
      'button[data-login-button]',
      'button[data-testid="login-button"]',
    ],
    loginPageUrlPatterns: [/\/auth\/login/i, /\/auth\/signup/i],
    loginFormSelectors: ['input[type="password"]'],
    completion: 'attribute',
    completeAttribute: 'data-message-complete',
    stableMs: 2500,
    guestAllowed: true,
  },
  qwen: {
    id: 'qwen',
    label: 'Qwen',
    url: 'https://chat.qwen.ai/',
    composerSelectors: [
      'textarea.message-input-textarea',
      'textarea[placeholder="Ask Qwen"]',
      'textarea[placeholder*="Qwen"]',
      'textarea',
      '[contenteditable="true"][role="textbox"]',
    ],
    sendSelectors: [
      'button.send-button[aria-label="Send"]',
      'button.send-button',
      '.message-input-right-button-send',
      '.chat-prompt-send-button',
      'button[aria-label*="Send" i]',
    ],
    assistantSelectors: [
      '.response-message-content.phase-answer',
      '.response-message-content',
      '.custom-qwen-markdown',
      '.qwen-markdown',
    ],
    contentSelectors: [
      '.custom-qwen-markdown',
      '.qwen-markdown',
    ],
    stopSelectors: [
      'button.stop-button',
      '.stop-button',
      '[class*="stop-button"]',
      'button[aria-label*="Stop" i]',
    ],
    loggedOutSelectors: [
      'button.header-right-auth-button',
    ],
    loginPageUrlPatterns: [/\/login/i, /\/signin/i],
    loginFormSelectors: ['input[type="password"]'],
    completion: 'stable',
    stableMs: 2800,
    guestAllowed: true,
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    url: 'https://chat.deepseek.com/',
    composerSelectors: [
      'textarea#chat-input',
      'textarea[name="search"]',
      'textarea[placeholder*="DeepSeek"]',
      'textarea[placeholder*="Message"]',
      'textarea[placeholder*="Сообщение"]',
      'textarea',
      'div[contenteditable="true"][role="textbox"]',
    ],
    sendSelectors: [
      'button[aria-label*="Send" i]',
      'button[aria-label*="Отправить" i]',
      '[role="button"][aria-label*="Send" i]',
      '[role="button"][aria-label*="Отправить" i]',
      '.ds-button.ds-button--primary',
      'button[type="submit"]',
      '[role="button"].ds-icon-button',
    ],
    assistantSelectors: [
      '.ds-markdown.ds-assistant-message-main-content',
      '.ds-markdown.ds-markdown--block',
      '.ds-message .ds-markdown',
      '.ds-markdown:not(.ds-think-content .ds-markdown)',
    ],
    contentSelectors: [],
    stopSelectors: [
      'button[aria-label*="Stop" i]',
      '[role="button"][aria-label*="Stop" i]',
      '.ds-stop-button',
      '[class*="stop-button"]',
      '.ds-message-loading',
    ],
    loggedOutSelectors: [],
    loginPageUrlPatterns: [/\/sign_in/i, /\/login/i, /\/signin/i],
    loginFormSelectors: ['input[type="password"]'],
    completion: 'stable',
    stableMs: 3500,
    guestAllowed: false,
  },
}

export const AGE_PATTERNS: RegExp[] = [
  /confirm your age/i,
  /what year were you born/i,
  /подтвердите[^.\n]{0,30}возраст/i,
  /укажите[^.\n]{0,30}год рождения/i,
  /确认[^.\n]{0,10}年龄/i,
]

export const CHALLENGE_PATTERNS: RegExp[] = [
  /(?:confirm|verify|check)(?:ing)? (?:that )?you(?:'re| are|.re)? (?:a )?human/i,
  /human verification/i,
  /security check before continuing/i,
  /verif(?:y|ies) that you are not a bot/i,
  /checking your browser/i,
  /just a moment/i,
  /cf-chl/i,
  /turnstile/i,
  /captcha/i,
  /подтвердите,? что вы (?:человек|робот)/i,
  /проверка браузера/i,
  /проверьте,? что вы человек/i,
  /人机验证/i,
]

export const LOGIN_DIALOG_PATTERNS: RegExp[] = [
  /log\s?in to continue/i,
  /sign\s?in to continue/i,
  /log\s?in to keep/i,
  /войдите[^.\n]{0,40}(?:продолж|использ)/i,
  /войдите в (?:систему|аккаунт)/i,
  /guest (?:mode )?limit/i,
  /лимит[^.\n]{0,40}гост/i,
  /登录以继续/i,
]

export const RATE_LIMIT_PATTERNS: RegExp[] = [
  /the server is busy[^.\n]*please try again later/i,
  /something went wrong[^.\n]*try again/i,
  /too many requests/i,
  /you(?:'|’)ve reached[^.\n]{0,80}limit/i,
  /rate limit[^.\n]{0,80}(?:reached|exceeded)/i,
  /слишком много запросов/i,
  /попробуйте (?:ещё|снова) (?:раз )?позже/i,
  /服务器繁忙/i,
  /请稍后再试/i,
]
