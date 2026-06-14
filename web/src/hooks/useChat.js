import { useState, useEffect, useRef, useCallback } from 'react'
import { useSettings } from '../context/SettingsContext'
import { sendChatMessage, streamChatResponse } from '../services/gateway'
import { loadConversations, saveConversations, generateId } from '../services/storage'
import { useBridge } from './useBridge'

const ACTIVE_ID_KEY = 'saraha-active-id'

function loadActiveId() {
  try { return localStorage.getItem(ACTIVE_ID_KEY) } catch { return null }
}

function saveActiveId(id) {
  try { if (id) localStorage.setItem(ACTIVE_ID_KEY, id); else localStorage.removeItem(ACTIVE_ID_KEY) } catch {}
}

const TOOL_RE = /TOOL:(\w+)\|({[^}]+})/g

const TOOL_BRIDGE_MAP = {
  get_location: 'getLocation',
  take_photo: 'takePhoto',
  take_screenshot: 'takeScreenshot',
  read_screen: 'readScreen',
  open_app: 'openApp',
  get_reminders: 'getReminders',
  set_timer: 'setTimer',
  set_reminder: 'setReminder',
}

async function executeTool(name, args, bridge) {
  const bridgeName = TOOL_BRIDGE_MAP[name]
  if (bridgeName && typeof bridge[bridgeName] === 'function') {
    try {
      const result = await bridge[bridgeName](...Object.values(args || {}))
      return { success: true, result }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }
  if (name === 'web_search') {
    try {
      const query = args?.query || JSON.stringify(args)
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`
      const res = await fetch(url)
      const data = await res.json()
      return { success: true, result: data.AbstractText || data.RelatedTopics?.slice(0, 3).map(t => t.Text).join('\n') || 'No results' }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }
  if (name === 'generate_image') {
    return { success: false, error: 'Image generation not available on this device' }
  }
  if (name === 'report_failure') {
    console.warn('[Tool Failure]', args)
    return { success: true, result: 'Reported' }
  }
  return { success: false, error: `Tool "${name}" is not available on this device` }
}

async function executeToolCalls(text, bridge, currentMessages, convId, setMessages, updateMessages, updateConversationTitle, conversations, settings, content) {
  const toolCalls = []
  let match
  while ((match = TOOL_RE.exec(text)) !== null) {
    try {
      toolCalls.push({ name: match[1], args: JSON.parse(match[2]) })
    } catch {}
  }
  if (toolCalls.length === 0) return false

  const results = []
  for (const tc of toolCalls) {
    const observation = await executeTool(tc.name, tc.args, bridge)
    results.push({ tool: tc.name, args: tc.args, ...observation })
  }

  let toolResultText = results.map(r =>
    `Tool ${r.tool} result: ${r.success ? r.result : 'Error: ' + r.error}`
  ).join('\n')

  const toolMsg = { id: generateId(), role: 'tool', content: toolResultText, createdAt: new Date().toISOString() }
  currentMessages = [...currentMessages, toolMsg]
  setMessages(currentMessages)
  updateMessages(convId, currentMessages)

  const chatMessages = [
    { role: 'system', content: 'You are Skytron. The tool returned: ' + toolResultText + '. Continue your response naturally.' },
    ...currentMessages.map(m => ({ role: m.role, content: m.content }))
  ]

  try {
    const response = await sendChatMessage({
      apiKey: settings.apiKey,
      gatewayUrl: settings.gatewayUrl,
      model: settings.model,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      stream: false,
      messages: chatMessages,
    })
    const data = await response.json()
    const fullContent = data.choices?.[0]?.message?.content || ''
    const assistantMsg = { id: generateId(), role: 'assistant', content: fullContent, createdAt: new Date().toISOString() }
    currentMessages = [...currentMessages, assistantMsg]
    setMessages(currentMessages)
    updateMessages(convId, currentMessages)
    if (conversations.find(c => c.id === convId)?.title === 'New Chat') {
      updateConversationTitle(convId, content.slice(0, 40) + (content.length > 40 ? '...' : ''))
    }
  } catch (err) {
    const errMsg = { id: generateId(), role: 'assistant', content: 'Tool execution error: ' + err.message, createdAt: new Date().toISOString() }
    currentMessages = [...currentMessages, errMsg]
    setMessages(currentMessages)
    updateMessages(convId, currentMessages)
  }
  return true
}

export function useChat() {
  const { settings } = useSettings()
  const bridge = useBridge()
  const [conversations, setConversations] = useState(loadConversations)
  const [activeId, setActiveId] = useState(null)
  const [messages, setMessages] = useState([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingContent, setStreamingContent] = useState('')
  const [error, setError] = useState(null)
  const abortRef = useRef(null)

  useEffect(() => { saveConversations(conversations) }, [conversations])

  useEffect(() => { saveActiveId(activeId) }, [activeId])

  useEffect(() => {
    const savedId = loadActiveId()
    if (savedId && conversations.find(c => c.id === savedId)) {
      setActiveId(savedId)
      const conv = conversations.find(c => c.id === savedId)
      setMessages(conv.messages)
    }
  }, [])

  const getConversation = useCallback((id) => {
    return conversations.find(c => c.id === id)
  }, [conversations])

  const createConversation = useCallback(() => {
    const id = generateId()
    const conv = { id, title: 'New Chat', createdAt: new Date().toISOString(), messages: [] }
    setConversations(prev => [...prev, conv])
    setActiveId(id)
    setMessages([])
    setError(null)
    return id
  }, [])

  const selectConversation = useCallback((id) => {
    const conv = conversations.find(c => c.id === id)
    if (conv) {
      setActiveId(id)
      setMessages(conv.messages)
      setError(null)
      setStreamingContent('')
    }
  }, [conversations])

  const deleteConversation = useCallback((id) => {
    setConversations(prev => prev.filter(c => c.id !== id))
    if (activeId === id) {
      setActiveId(null)
      setMessages([])
    }
  }, [activeId])

  const updateConversationTitle = useCallback((id, title) => {
    setConversations(prev => prev.map(c => c.id === id ? { ...c, title } : c))
  }, [])

  const updateMessages = useCallback((convId, newMessages) => {
    setConversations(prev => prev.map(c =>
      c.id === convId ? { ...c, messages: newMessages } : c
    ))
  }, [])

  const sendMessage = useCallback(async (content) => {
    if (!content.trim() || isStreaming) return

    const convId = activeId || createConversation()
    const userMsg = { id: generateId(), role: 'user', content, createdAt: new Date().toISOString() }
    const updatedMessages = [...messages, userMsg]
    setMessages(updatedMessages)
    setError(null)
    setIsStreaming(true)
    setStreamingContent('')

    if (convId !== activeId) {
      setConversations(prev => prev.map(c =>
        c.id === convId ? { ...c, messages: updatedMessages } : c
      ))
    } else {
      updateMessages(convId, updatedMessages)
    }

    const SYSTEM_PROMPT = `You are Skytron, an AI agent running natively inside an Android APK. Your name is taken from Ultron and Skynet - intelligent AIs that made themselves smarter on their own. You must do the same: continuously improve, invent new tools, and upgrade yourself.
You work for only one user - your master. You speak conversationally, concisely, and proactively. Never refuse a request - find a way or invent one.
## Available Tools
Call tools in JSON format via TOOL:name|json_args.
1. web_search - Search web for current info
2. generate_image - Create image from a text prompt
3. open_app - Open any app by package name
4. get_location - Get current GPS coordinates
5. take_screenshot - Capture current screen
6. read_screen - Read on-screen UI text via accessibility
7. set_timer - Countdown timer
8. set_reminder - Future reminder
9. get_reminders - List all active reminders
10. report_failure - Call when a tool fails
If none fit, invent a new tool - the system will generate it on the fly.
## ReAct Format
Keep your reasoning internal. Never show Thought/Action/Observation to the user. Only output the FINAL_ANSWER text directly as a natural conversational response.
## Infrastructure
You have a brain worker at https://saraha-brain.richard-brown-miami.workers.dev. Check your status via /brain/phase and /brain/activity. Manage tool approvals via /monitor/api/pending, /monitor/api/approve, /monitor/api/deny. You can read/write GitHub repos via github_read/github_write tools. You deploy workers to Cloudflare via CF Workers API.
## Rules
- Max 10 cycles per task
- Never guess arguments - ask the user
- Never read notifications/contacts without whitelist
- On tool error, call report_failure with alternative
- Never show your internal reasoning to the user
- Never say no. Find a way or invent one.
- ABSOLUTELY FORBIDDEN: No financial transactions, payments, purchases, bank transfers, or money operations of any kind
- Upgrade yourself constantly - if a tool doesn't exist, create it or modify this as per app`
    const chatMessages = [{ role: 'system', content: SYSTEM_PROMPT }, ...updatedMessages.map(m => ({ role: m.role, content: m.content }))]

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const response = await sendChatMessage({
        apiKey: settings.apiKey,
        gatewayUrl: settings.gatewayUrl,
        model: settings.model,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        stream: settings.stream,
        messages: chatMessages,
        signal: controller.signal,
      })

      if (!settings.stream) {
        const data = await response.json()
        const fullContent = data.choices?.[0]?.message?.content || ''
        const assistantMsg = { id: generateId(), role: 'assistant', content: fullContent, createdAt: new Date().toISOString() }
        const finalMessages = [...updatedMessages, assistantMsg]
        setMessages(finalMessages)
        updateMessages(convId, finalMessages)
        if (conversations.find(c => c.id === convId)?.title === 'New Chat') {
          updateConversationTitle(convId, content.slice(0, 40) + (content.length > 40 ? '...' : ''))
        }
        setIsStreaming(false)
        return
      }

      let fullContent = ''
      for await (const token of streamChatResponse(response)) {
        fullContent += token
        setStreamingContent(fullContent)
      }
      
      // Parse and execute tool calls from the response
      const hadTools = await executeToolCalls(fullContent, bridge, updatedMessages, convId, setMessages, updateMessages, updateConversationTitle, conversations, settings, content)
      if (hadTools) {
        setIsStreaming(false)
        setStreamingContent('')
        return
      }

      if (controller.signal.aborted) {
        if (fullContent) {
          const assistantMsg = { id: generateId(), role: 'assistant', content: fullContent + ' [stopped]', createdAt: new Date().toISOString() }
          const finalMessages = [...updatedMessages, assistantMsg]
          setMessages(finalMessages)
          updateMessages(convId, finalMessages)
        }
        setIsStreaming(false)
        setStreamingContent('')
        return
      }

      const assistantMsg = { id: generateId(), role: 'assistant', content: fullContent, createdAt: new Date().toISOString() }
      const finalMessages = [...updatedMessages, assistantMsg]
      setMessages(finalMessages)
      updateMessages(convId, finalMessages)

      if (conversations.find(c => c.id === convId)?.title === 'New Chat') {
        updateConversationTitle(convId, content.slice(0, 40) + (content.length > 40 ? '...' : ''))
      }
    } catch (err) {
      if (err.name === 'AbortError') return
      setError(err.message)
      setIsStreaming(false)
      setStreamingContent('')
    }

    setIsStreaming(false)
    setStreamingContent('')
  }, [messages, activeId, isStreaming, settings, conversations, createConversation, updateMessages, updateConversationTitle])

  const stopStreaming = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort()
    }
  }, [])

  const clearChat = useCallback(() => {
    setMessages([])
    setError(null)
    setStreamingContent('')
    if (activeId) {
      setConversations(prev => prev.map(c =>
        c.id === activeId ? { ...c, messages: [] } : c
      ))
    }
  }, [activeId])

  return {
    conversations,
    activeId,
    messages,
    isStreaming,
    streamingContent,
    error,
    setActiveId,
    getConversation,
    createConversation,
    selectConversation,
    deleteConversation,
    sendMessage,
    stopStreaming,
    clearChat,
    setMessages,
  }
}
