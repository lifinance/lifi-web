import './SwapV2.css'

import { Token } from '@lifi/sdk'
import { LiFiWidget, WidgetConfig } from '@lifi/widget'
import { useWeb3React } from '@web3-react/core'
import { useMemo, useState } from 'react'

import { useMetatags } from '../hooks/useMetatags'
import { addChain, switchChain, switchChainAndAddToken } from '../services/metamask'
import { useStomt } from '../services/stomt'
import { addToDeactivatedWallets, removeFromActiveWallets } from './web3/DisconnectButton'
import { WalletModal } from './web3/WalletModal'

export const SwapV2 = () => {
  useMetatags({ title: 'LI.FI - Swap' })
  useStomt('swap')

  const { library, deactivate, account } = useWeb3React()
  const signer = useMemo(() => {
    try {
      return library.getSigner()
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(e)
    }
  }, [library])

  const [showConnectModal, setShowConnectModal] = useState<{
    show: boolean
    promiseResolver?: Function
  }>({ show: false })

  const widgetConfig: WidgetConfig = useMemo(() => {
    return {
      walletManagement: {
        signer: signer,
        connect: async () => {
          let promiseResolver
          const loginAwaiter = new Promise<void>((resolve) => (promiseResolver = resolve))

          setShowConnectModal({ show: true, promiseResolver })

          await loginAwaiter
          return library.getSigner()
        },
        disconnect: async () => {
          removeFromActiveWallets(account)
          addToDeactivatedWallets(account)
          deactivate()
        },
        switchChain: async (reqChainId: number) => {
          await switchChain(reqChainId)
          return library.getSigner()
        },
        addToken: async (token: Token, chainId: number) => {
          await switchChainAndAddToken(chainId, token)
        },
        addChain: async (chainId: number) => {
          return addChain(chainId)
        },
      },
      containerStyle: {
        height: 'calc(100% - 160px)',
        border: `1px solid ${
          window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'rgb(66, 66, 66)'
            : 'rgb(234, 234, 234)'
        }`,
        borderRadius: '16px',
        display: 'flex',
        minWidth: 360,
        maxHeight: 736,
      },
    }
  }, [library, account, signer])

  return (
    <>
      <LiFiWidget config={widgetConfig} />
      <WalletModal
        show={showConnectModal.show}
        onOk={() => {
          setShowConnectModal({ show: false })
          showConnectModal.promiseResolver?.()
        }}
        onCancel={() => {
          setShowConnectModal({ show: false, promiseResolver: undefined })
        }}
      />
    </>
  )
}
