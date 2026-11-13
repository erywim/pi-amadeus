import { createBrowserRouter } from 'react-router'
import AppShell from './components/layout/AppShell'
import ChatPage from './features/chat/ChatPage'
import DashboardPage from './features/dashboard/DashboardPage'
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
      { path: 'plugins', element: <PluginsPage /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'settings', element: <SettingsPage /> }
    ]
  }
])
