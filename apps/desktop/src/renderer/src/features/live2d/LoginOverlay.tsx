import * as React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DigitalRain } from '@renderer/components/effects/DigitalRain'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { loginUser } from '@renderer/lib/api'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useUiStore } from '@renderer/stores/uiStore'

/** 数字雨登录覆盖层：输入用户名进入（首次启动由此建档服务端用户身份） */
export function LoginOverlay(): React.JSX.Element {
  const { t } = useTranslation()
  const open = useUiStore((s) => s.loginOpen)
  const [name, setName] = useState('')

  if (!open) return <></>

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const username = name.trim() || 'Guest'
    try {
      // 登录成功后从服务端恢复身份
      await loginUser(username)
      await useSessionStore.getState().init()
    } catch (error) {
      console.log('[auth] 登录失败',error)
    }
  }

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/85">
      <DigitalRain className="opacity-60" />
      <form
        onSubmit={submit}
        className="relative z-10 w-[340px] space-y-5 rounded-lg border border-primary/30 bg-card/90 p-8 shadow-[0_0_40px_rgba(0,229,255,0.15)] backdrop-blur-sm"
      >
        <div className="text-center">
          <h2 className="glitch-title font-mono text-xl font-bold tracking-[0.2em] text-primary text-glow-cyan">
            {t('live2d.login.title')}
          </h2>
          <p className="mt-2 text-xs text-muted-foreground">{t('live2d.login.subtitle')}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="login-username">{t('live2d.login.username')}</Label>
          <Input
            id="login-username"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('live2d.login.usernamePlaceholder')}
            autoFocus
          />
        </div>
        <Button type="submit" className="w-full">
          {t('live2d.login.enter')}
        </Button>
      </form>
    </div>
  )
}
