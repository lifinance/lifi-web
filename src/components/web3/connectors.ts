import { InjectedConnector } from '@web3-react/injected-connector'
import { NetworkConnector } from '@web3-react/network-connector'
import { WalletConnectConnector } from '@web3-react/walletconnect-connector'
import { providers } from 'ethers'

import { ChainId, getChainById, supportedChains } from '../../types'

const customRpc: Record<number, string | undefined> = {
  [ChainId.ETH]: process.env.REACT_APP_RPC_URL_MAINNET
    ? process.env.REACT_APP_RPC_URL_MAINNET.split(',')[0]
    : undefined,
  [ChainId.POL]: process.env.REACT_APP_RPC_URL_POLYGON,
  [ChainId.BSC]: process.env.REACT_APP_RPC_URL_BSC,
  [ChainId.DAI]: process.env.REACT_APP_RPC_URL_XDAI,
  [ChainId.FTM]: process.env.REACT_APP_RPC_URL_FANTOM,
  [ChainId.ARB]: process.env.REACT_APP_RPC_URL_ARBITRUM,
  [ChainId.OPT]: process.env.REACT_APP_RPC_URL_OPTIMISM,
  [ChainId.MOR]: process.env.REACT_APP_RPC_URL_MOONRIVER,
  [ChainId.ONE]: process.env.REACT_APP_RPC_URL_ONE,
  [ChainId.AUR]: process.env.REACT_APP_RPC_URL_AURORA,

  // Testnet
  [ChainId.ROP]: process.env.REACT_APP_RPC_URL_ROPSTEN,
  [ChainId.RIN]: process.env.REACT_APP_RPC_URL_RINKEBY,
  [ChainId.GOR]: process.env.REACT_APP_RPC_URL_GORLI,
  [ChainId.KOV]: process.env.REACT_APP_RPC_URL_KOVAN,
  [ChainId.ARBT]: process.env.REACT_APP_RPC_URL_ARBITRUM_RINKEBY,
  [ChainId.OPTT]: process.env.REACT_APP_RPC_URL_OPTIMISM_KOVAN,
  [ChainId.MUM]: process.env.REACT_APP_RPC_URL_POLYGON_MUMBAI,
  [ChainId.BSCT]: process.env.REACT_APP_RPC_URL_BSC_TESTNET,
}

// cached providers
const chainProviders: Record<number, providers.FallbackProvider> = {}

export const getRpcUrl = (chainId: number) => {
  return customRpc[chainId] || getChainById(chainId).metamask.rpcUrls[0]
}

export const getRpcProvider = (chainId: number) => {
  if (!chainProviders[chainId]) {
    chainProviders[chainId] = new providers.FallbackProvider([
      new providers.JsonRpcProvider(getRpcUrl(chainId), chainId),
    ])
  }
  return chainProviders[chainId]
}

export const getRpcProviders = (chainIds: Array<number>) => {
  const selectedProviders: Record<number, providers.FallbackProvider> = {}
  chainIds.forEach((chainId) => {
    selectedProviders[chainId] = getRpcProvider(chainId)
  })
  return selectedProviders
}

export const getRpcUrls = (chainIds: Array<number>) => {
  const selectedProviders: Record<number, string[]> = {}
  chainIds.forEach((chainId) => {
    selectedProviders[chainId] = [getRpcUrl(chainId)]
  })
  return selectedProviders
}

export const injected = new InjectedConnector({
  supportedChainIds: supportedChains.map((chain) => chain.id),
})

// get our standard supported chain and try to append the possibly unknown chain the user is on
export const getInjectedConnector = async () => {
  const { ethereum } = window as any
  const currentProvider = new providers.Web3Provider(ethereum)
  const chainId = (await currentProvider.getNetwork()).chainId
  // append the current chain to the supported chains.
  // can push duplicate ids, when user is on supported chain but that does not seem to make any problems.
  const chains = [...supportedChains.map((chain) => chain.id), chainId]
  return new InjectedConnector({
    supportedChainIds: chains,
  })
}

const walletConnectConnector = new WalletConnectConnector({
  supportedChainIds: [...supportedChains.map((chain) => chain.id)],
  bridge: 'https://bridge.walletconnect.org',
  qrcode: true,
  rpc: Object.fromEntries(
    supportedChains.map((chain) => {
      return [chain.id, chain.metamask.rpcUrls[0] || '']
    }),
  ),
})

export const getWalletConnectConnector = async () => {
  return walletConnectConnector
}

export const network = new NetworkConnector({
  urls: Object.fromEntries(
    supportedChains.map((chain) => chain.id).map((chainId) => [chainId, getRpcUrl(chainId)]),
  ),
  defaultChainId: ChainId.ETH,
})
