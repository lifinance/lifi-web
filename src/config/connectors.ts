import { ChainId } from '@lifi/sdk'

import { deepClone } from '../services/utils'

const load = (value?: string) => {
  return value ? value.split(',') : []
}

const customRpc: Record<number, (string | undefined)[]> = {
  [ChainId.ETH]: load(process.env.REACT_APP_RPC_URL_MAINNET),
  [ChainId.POL]: load(process.env.REACT_APP_RPC_URL_POLYGON),
  [ChainId.BSC]: load(process.env.REACT_APP_RPC_URL_BSC),
  [ChainId.DAI]: load(process.env.REACT_APP_RPC_URL_XDAI),
  [ChainId.FTM]: load(process.env.REACT_APP_RPC_URL_FANTOM),
  [ChainId.ARB]: load(process.env.REACT_APP_RPC_URL_ARBITRUM),
  [ChainId.OPT]: load(process.env.REACT_APP_RPC_URL_OPTIMISM),
  [ChainId.MOR]: load(process.env.REACT_APP_RPC_URL_MOONRIVER),
  [ChainId.ONE]: load(process.env.REACT_APP_RPC_URL_ONE),
  [ChainId.AUR]: load(process.env.REACT_APP_RPC_URL_AURORA),

  // Testnet
  [ChainId.ROP]: load(process.env.REACT_APP_RPC_URL_ROPSTEN),
  [ChainId.RIN]: load(process.env.REACT_APP_RPC_URL_RINKEBY),
  [ChainId.GOR]: load(process.env.REACT_APP_RPC_URL_GORLI),
  [ChainId.KOV]: load(process.env.REACT_APP_RPC_URL_KOVAN),
  [ChainId.ARBT]: load(process.env.REACT_APP_RPC_URL_ARBITRUM_RINKEBY),
  [ChainId.OPTT]: load(process.env.REACT_APP_RPC_URL_OPTIMISM_KOVAN),
  [ChainId.MUM]: load(process.env.REACT_APP_RPC_URL_POLYGON_MUMBAI),
  [ChainId.BSCT]: load(process.env.REACT_APP_RPC_URL_BSC_TESTNET),
}

export const getRpcs = (): Record<number, string[]> => {
  const rpcs = deepClone(customRpc)
  Object.keys(rpcs).forEach((key) => {
    if (!rpcs[key] || !rpcs[key].length || !rpcs[key][0]) {
      delete rpcs[key]
    }
  })

  return rpcs
}
