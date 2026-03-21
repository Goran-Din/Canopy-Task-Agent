import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import LandscapeApp from './LandscapeApp.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <LandscapeApp />
  </StrictMode>,
)
