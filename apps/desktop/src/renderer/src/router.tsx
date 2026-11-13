import { createBrowserRouter } from 'react-router'
import AppShell from './components/layout/AppShell'
import ChatPage from './features/chat/ChatPage'
import DashboardPage from './features/dashboard/DashboardPage'
import ConversionPage from './features/conversion/ConversionPage'
import MemoryPage from './features/memory/MemoryPage'
import PluginsPage from './features/plugins/PluginsPage'
import SettingsPage from './features/settings/SettingsPage'
import { CompanionRoute, IndexRedirect } from './routerBits'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <IndexRedirect /> },
      { path: 'companion', element: <CompanionRoute /> },
      { path: 'text', element: <ChatPage /> },
      { path: 'memory', element: <MemoryPage /> },
      { path: 'plugins', element: <PluginsPage /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'conversion', element: <ConversionPage /> },
      { path: 'settings', element: <SettingsPage /> }
    ]
  }
])
