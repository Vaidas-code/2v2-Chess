import { StrictMode, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { GoogleOAuthProvider } from '@react-oauth/google'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App.js'

const googleClientId = typeof import.meta.env.VITE_GOOGLE_CLIENT_ID === 'string'
  ? import.meta.env.VITE_GOOGLE_CLIENT_ID.trim()
  : ''

const appTree = createElement(BrowserRouter, null, createElement(App))
const wrappedAppTree = googleClientId
  ? createElement(GoogleOAuthProvider, { clientId: googleClientId }, appTree)
  : appTree

createRoot(document.getElementById('root')).render(
  createElement(StrictMode, null, wrappedAppTree),
)