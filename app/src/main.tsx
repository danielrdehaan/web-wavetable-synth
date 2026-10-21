import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { EmbedApp } from './embed/EmbedApp'
import './app.css'

const params = new URLSearchParams(location.search)
createRoot(document.getElementById('root')!).render(<StrictMode>{params.has('embed') ? <EmbedApp params={params} /> : <App />}</StrictMode>)
