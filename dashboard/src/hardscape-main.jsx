import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import HardscapeApp from './HardscapeApp.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <HardscapeApp />
  </StrictMode>,
)
