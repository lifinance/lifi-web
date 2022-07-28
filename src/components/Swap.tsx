import './Swap.css'

import { LoadingOutlined, SwapOutlined, SyncOutlined } from '@ant-design/icons'
import { Web3Provider } from '@ethersproject/providers'
import { useWeb3React } from '@web3-react/core'
import {
  Button,
  Checkbox,
  Col,
  Collapse,
  Form,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Tabs,
  Tooltip,
  Typography,
} from 'antd'
import { Content } from 'antd/lib/layout/layout'
import Title from 'antd/lib/typography/Title'
import BigNumber from 'bignumber.js'
import { ethers } from 'ethers'
import { createBrowserHistory } from 'history'
import QueryString from 'qs'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { v4 as uuid } from 'uuid'

import { useMetatags } from '../hooks/useMetatags'
import LiFi from '../LiFi'
import { useChainsTokensTools } from '../providers/chainsTokensToolsProvider'
import {
  deleteRoute,
  isWalletConnectWallet,
  readActiveRoutes,
  readHistoricalRoutes,
  resetForegroundRoute,
  storeRoute,
} from '../services/localStorage'
import { switchChain as switchChainMetaMask } from '../services/metamask'
import { useStomt } from '../services/stomt'
import { loadTokenListAsTokens } from '../services/tokenListService'
import {
  deepClone,
  formatTokenAmount,
  formatTokenAmountOnly,
  getBalance,
  isWalletDeactivated,
} from '../services/utils'
import {
  Chain,
  ChainId,
  ChainKey,
  CoinKey,
  findDefaultToken,
  getChainById,
  getChainByKey,
  isSwapStep,
  Order,
  Route as RouteType,
  RoutesRequest,
  RoutesResponse,
  SwapPageStartParams,
  Token,
  TokenAmount,
  TokenAmountList,
} from '../types'
import { RouteList } from './RouteList/Routelist'
import SwapForm from './SwapForm/SwapForm'
import Swapping from './Swapping'
import TransactionsTable from './TransactionsTable'
import { WalletConnectChainSwitchModal } from './WalletConnectChainSwitchModal'
import ConnectButton from './web3/ConnectButton'

const TOTAL_SLIPPAGE_GUARD_MODAL = new BigNumber(0.9)

const history = createBrowserHistory()
const { TabPane } = Tabs

const availableOrders = [
  {
    key: 'RECOMMENDED',
    name: 'Recommended',
  },
  {
    key: 'SAFEST',
    name: 'Safest',
  },
  {
    key: 'FASTEST',
    name: 'Fastest',
  },
  {
    key: 'CHEAPEST',
    name: 'Cheapest',
  },
]

let currentRouteCallId: string

interface TokenWithAmounts extends Token {
  amount?: BigNumber
  amountRendered?: string
}

const parseChain = (passed: string) => {
  // is ChainKey?
  const chainKeys = Object.values(ChainKey) as string[]
  if (chainKeys.includes(passed.toLowerCase())) {
    return ChainId[passed.toUpperCase() as keyof typeof ChainId]
  }

  // is ChainId?
  const id = parseInt(passed)
  if (!isNaN(id)) {
    return id
  }
}

const parseToken = (
  passed: string,
  chainKey: ChainKey,
  transferTokens: { [ChainKey: string]: Array<Token> },
) => {
  // is CoinKey?
  const coinKeys = Object.values(CoinKey)
  const coinKey = passed.toUpperCase() as CoinKey
  if (coinKeys.includes(coinKey)) {
    return findDefaultToken(coinKey, getChainByKey(chainKey).id)
  }

  // is token address valid?
  const fromTokenId = ethers.utils.getAddress(passed.trim()).toLowerCase()
  // does token address exist in our default tokens? (tokenlists not loaded yet)
  return transferTokens[chainKey]?.find((token) => token.address === fromTokenId)
}

const Swap = () => {
  useMetatags({
    title: 'LI.FI - Swap',
  })
  useStomt('swap')
  const chainsTokensTools = useChainsTokensTools()

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [unused, setStateUpdate] = useState<number>(0)

  const [availableChains, setAvailableChains] = useState<Chain[]>(chainsTokensTools.chains)

  // From
  const [fromChainKey, setFromChainKey] = useState<ChainKey | undefined>()
  const [depositAmount, setDepositAmount] = useState<BigNumber>(new BigNumber(0))
  const [fromTokenAddress, setFromTokenAddress] = useState<string | undefined>()
  const [toChainKey, setToChainKey] = useState<ChainKey | undefined>()
  const [withdrawAmount, setWithdrawAmount] = useState<BigNumber>(new BigNumber(Infinity))
  const [toTokenAddress, setToTokenAddress] = useState<string | undefined>()
  const [tokens, setTokens] = useState<TokenAmountList>(chainsTokensTools.tokens)
  const [refreshTokens, setRefreshTokens] = useState<boolean>(false)
  const [balances, setBalances] = useState<{ [ChainKey: string]: Array<TokenAmount> }>()
  const [refreshBalances, setRefreshBalances] = useState<boolean>(true)
  const [routeCallResult, setRouteCallResult] = useState<{ result: RoutesResponse; id: string }>()

  // Options
  const [optionOrder, setOptionOrder] = useState<Order>('RECOMMENDED' as Order)
  const [optionSlippage, setOptionSlippage] = useState<number>(3)
  const [optionInfiniteApproval, setOptionInfiniteApproval] = useState<boolean>(false)
  const [optionEnabledBridges, setOptionEnabledBridges] = useState<string[] | undefined>(
    chainsTokensTools.bridges,
  )
  const [availableBridges, setAvailableBridges] = useState<string[]>(chainsTokensTools.bridges)
  const [optionEnabledExchanges, setOptionEnabledExchanges] = useState<string[] | undefined>(
    chainsTokensTools.exchanges,
  )
  const [availableExchanges, setAvailableExchanges] = useState<string[]>(
    chainsTokensTools.exchanges,
  )

  // Routes
  const [routes, setRoutes] = useState<Array<RouteType>>([])
  const [routesLoading, setRoutesLoading] = useState<boolean>(false)
  const [noRoutesAvailable, setNoRoutesAvailable] = useState<boolean>(false)
  const [selectedRoute, setSelectedRoute] = useState<RouteType | undefined>()
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1)
  const [activeRoutes, setActiveRoutes] = useState<Array<RouteType>>(readActiveRoutes())
  const [historicalRoutes, setHistoricalRoutes] = useState<Array<RouteType>>(readHistoricalRoutes())

  // Misc
  const [restartedOnPageLoad, setRestartedOnPageLoad] = useState<boolean>(false)
  const [balancePollingStarted, setBalancePollingStarted] = useState<boolean>(false)
  const [startParamsDefined, setStartParamsDefined] = useState<boolean>(false)
  const tokensAndChainsSet = useMemo(
    () => availableChains.length !== 0 && Object.keys(tokens).length !== 0,
    [tokens, availableChains],
  )
  const transactionInfoRef = useRef<null | HTMLDivElement>(null)
  const [activeTransactionInfoTabKey, setActiveTransactionInfoTabKey] = useState<string>()

  const [showWalletConnectChainSwitchModal, setShowWalletConnectChainSwitchModal] = useState<{
    show: boolean
    chainId: number
  }>({ show: false, chainId: 1 })

  // Wallet
  const web3 = useWeb3React<Web3Provider>()
  const { active } = useWeb3React()

  useEffect(() => {
    // get new execution status on page load
    if (!restartedOnPageLoad) {
      setRestartedOnPageLoad(true)

      activeRoutes.map((route) => {
        if (!web3 || !web3.library) return
        // check if it makes sense to fetch the status of a route:
        // if failed or action required it makes no sense
        const routeFailed = route.steps.some(
          (step) => step.execution && step.execution.status === 'FAILED',
        )
        const actionRequired = route.steps.some(
          (step) =>
            step.execution &&
            step.execution.process.some((process) => process.status === 'ACTION_REQUIRED'),
        )

        if (routeFailed || actionRequired) return
        const settings = {
          updateCallback: (updatedRoute: RouteType) => {
            storeRoute(updatedRoute)
            setActiveRoutes(readActiveRoutes())
            setHistoricalRoutes(readHistoricalRoutes())
          },
        }
        LiFi.resumeRoute(web3.library.getSigner(), route, settings)
        LiFi.moveExecutionToBackground(route)
      })
    }
  }, [web3.library])

  useEffect(() => {
    // executed once after page is loaded
    if (!balancePollingStarted) {
      setBalancePollingStarted(true)

      // start balance polling
      const pollingInterval = setInterval(() => {
        setRefreshBalances(true)
      }, 60_000)

      return () => {
        clearInterval(pollingInterval)
      }
    }
  }, [])

  // get chains
  useEffect(() => {
    setAvailableChains(chainsTokensTools.chains)

    // load()
  }, [chainsTokensTools.chains])

  //get tokens
  useEffect(() => {
    setTokens(chainsTokensTools.tokens)
  }, [chainsTokensTools.tokens])

  //get tools
  useEffect(() => {
    setAvailableExchanges(chainsTokensTools.exchanges)
    setOptionEnabledExchanges(chainsTokensTools.exchanges)
    setAvailableBridges(chainsTokensTools.bridges)
    setOptionEnabledBridges(chainsTokensTools.bridges)
  }, [chainsTokensTools.bridges, chainsTokensTools.exchanges])

  useEffect(() => {
    if (tokensAndChainsSet) {
      setRefreshBalances(true)
    }
  }, [availableChains, tokens])

  const updateTokenData = (token: Token) => {
    LiFi.getToken(token.chainId, token.address).then((updatedToken: TokenWithAmounts) => {
      // sync optional properties
      updatedToken.logoURI = updatedToken.logoURI || token.logoURI
      updatedToken.priceUSD = updatedToken.priceUSD || token.priceUSD

      // update tokens
      setTokens((tokens) => {
        const chain = getChainById(updatedToken.chainId)
        if (!tokens[chain.key]) tokens[chain.key] = []
        const index = tokens[chain.key].findIndex((token) => token.address === updatedToken.address)
        if (index === -1) {
          tokens[chain.key].push(updatedToken)
        } else {
          tokens[chain.key][index] = updatedToken
        }
        return tokens
      })
    })
  }

  const getDefaultParams = (
    search: string,
    availableChains: Chain[],
    transferTokens: { [ChainKey: string]: Array<Token> },
  ) => {
    const defaultParams: SwapPageStartParams = {
      depositChain: undefined,
      depositToken: undefined,
      depositAmount: new BigNumber(-1),
      withdrawChain: undefined,
      withdrawToken: undefined,
    }

    const params = QueryString.parse(search, { ignoreQueryPrefix: true })

    // fromChain
    let newFromChain
    if (params.fromChain && typeof params.fromChain === 'string') {
      try {
        const newFromChainId = parseChain(params.fromChain)
        newFromChain = availableChains.find((chain) => chain.id === newFromChainId)

        if (newFromChain) {
          defaultParams.depositChain = newFromChain.key
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(e)
      }
    }

    // fromToken
    if (params.fromToken && typeof params.fromToken === 'string' && defaultParams.depositChain) {
      try {
        const foundToken = parseToken(params.fromToken, defaultParams.depositChain, transferTokens)
        const inDefault = transferTokens[defaultParams.depositChain].find(
          (token) => token.address === foundToken?.address,
        )
        if (foundToken && inDefault) {
          defaultParams.depositToken = foundToken.address
        } else if (foundToken) {
          transferTokens[defaultParams.depositChain].push(foundToken)
          defaultParams.depositToken = foundToken.address
        } else if (newFromChain) {
          // only add unknow token if chain was specified with it
          const fromTokenId = ethers.utils.getAddress(params.fromToken.trim()).toLowerCase()
          const newToken = {
            address: fromTokenId,
            symbol: 'Unknown',
            decimals: 18,
            chainId: newFromChain.id,
            coinKey: '' as CoinKey,
            name: 'Unknown',
            logoURI: '',
          }
          transferTokens[defaultParams.depositChain].push(newToken)

          updateTokenData(newToken)
          defaultParams.depositToken = fromTokenId
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(e)
      }
    }

    // fromAmount
    if (params.fromAmount && typeof params.fromAmount === 'string') {
      try {
        const newAmount = new BigNumber(params.fromAmount)
        if (newAmount.gt(0)) {
          defaultParams.depositAmount = newAmount
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(e)
      }
    }

    // toChain
    let newToChain
    if (params.toChain && typeof params.toChain === 'string') {
      try {
        const newToChainId = parseChain(params.toChain)
        newToChain = availableChains.find((chain) => chain.id === newToChainId)

        if (newToChain) {
          defaultParams.withdrawChain = newToChain.key
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(e)
      }
    }

    // toToken
    if (params.toToken && typeof params.toToken === 'string' && defaultParams.withdrawChain) {
      try {
        const foundToken = parseToken(params.toToken, defaultParams.withdrawChain, transferTokens)

        const inDefault = transferTokens[defaultParams.withdrawChain].find(
          (token) => token.address === foundToken?.address,
        )
        if (foundToken && inDefault) {
          defaultParams.withdrawToken = foundToken.address
        } else if (foundToken) {
          transferTokens[defaultParams.withdrawChain].push(foundToken)
          defaultParams.withdrawToken = foundToken.address
        } else if (newToChain) {
          // only add unknow token if chain was specified with it
          const toTokenId = ethers.utils.getAddress(params.toToken.trim()).toLowerCase()
          const newToken = {
            address: toTokenId,
            symbol: 'Unknown',
            decimals: 18,
            chainId: newToChain.id,
            coinKey: '' as CoinKey,
            name: 'Unknown',
            logoURI: '',
          }
          transferTokens[defaultParams.withdrawChain].push(newToken)
          updateTokenData(newToken)
          defaultParams.withdrawToken = toTokenId
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(e)
      }
    }
    return defaultParams
  }

  const getSelectedWithdraw = () => {
    if (highlightedIndex === -1) {
      return {
        estimate: '0.0',
      }
    } else {
      const selectedRoute = routes[highlightedIndex]
      const lastStep = selectedRoute.steps[selectedRoute.steps.length - 1]
      return {
        estimate: formatTokenAmountOnly(lastStep.action.toToken, lastStep.estimate?.toAmount),
        min: formatTokenAmount(lastStep.action.toToken, lastStep.estimate?.toAmountMin),
      }
    }
  }

  // autoselect from chain based on wallet
  useEffect(() => {
    if (!fromChainKey && startParamsDefined) {
      const walletChainIsSupported = availableChains.some((chain) => chain.id === web3.chainId)
      if (!walletChainIsSupported) return
      if (web3.chainId && !fromChainKey) {
        const chain = availableChains.find((chain) => chain.id === web3.chainId)
        if (chain) {
          setFromChainKey(chain.key)
        }
      }
    }
  }, [web3.chainId, fromChainKey, availableChains, startParamsDefined])

  useEffect(() => {
    if (tokensAndChainsSet) {
      const startParams = getDefaultParams(history.location.search, availableChains, tokens)
      setFromChainKey(startParams.depositChain)
      setDepositAmount(startParams.depositAmount)
      setFromTokenAddress(startParams.depositToken)
      setToChainKey(startParams.withdrawChain)
      setToTokenAddress(startParams.withdrawToken)
      setStartParamsDefined(true)
    }
  }, [availableChains, tokens])

  // update query string
  useEffect(() => {
    if (startParamsDefined) {
      const params = {
        fromChain: fromChainKey,
        fromToken: fromTokenAddress,
        toChain: toChainKey,
        toToken: toTokenAddress,
        fromAmount: depositAmount.gt(0) ? depositAmount.toFixed() : undefined,
      }
      const search = QueryString.stringify(params)
      history.push({
        pathname: '/swap',
        search,
      })
    }
  }, [
    fromChainKey,
    fromTokenAddress,
    toChainKey,
    toTokenAddress,
    depositAmount,
    startParamsDefined,
  ])

  useEffect(() => {
    if (refreshTokens) {
      setRefreshTokens(false)

      availableChains.map(async (chain) => {
        const newTokens = {
          [chain.key]: await loadTokenListAsTokens(chain.id),
        }
        setTokens((tokens) => Object.assign(tokens, newTokens))
        setStateUpdate((stateUpdate) => stateUpdate + 1)
      })
    }
  }, [refreshTokens, availableChains])

  const updateBalances = useCallback(async () => {
    if (web3.account) {
      // one call per chain to show balances as soon as the request comes back
      Object.entries(tokens).forEach(([chainKey, tokenList]) => {
        LiFi.getTokenBalances(web3.account!, tokenList).then((portfolio: any) => {
          setBalances((balances) => {
            if (!balances) balances = {}
            return {
              ...balances,
              [chainKey]: portfolio,
            }
          })
        })
      })
    }
  }, [web3.account, tokens])

  useEffect(() => {
    if (refreshBalances && web3.account) {
      setRefreshBalances(false)
      updateBalances()
    }
  }, [refreshBalances, web3.account, updateBalances])

  useEffect(() => {
    if (!web3.account) {
      setBalances(undefined) // reset old balances
    }
  }, [web3.account])

  useEffect(() => {
    // merge tokens and balances
    for (const chain of availableChains) {
      if (!tokens[chain.key]) {
        continue
      }
      for (const token of tokens[chain.key]) {
        if (!balances || !balances[chain.key]) {
          // balances for chain not loaded yet
          token.amount = new BigNumber(-1)
          token.amountRendered = undefined
        } else {
          // balances loaded
          token.amount = getBalance(balances, chain.key, token.address)
          token.amountRendered = formatTokenAmountOnly(token, token.amount)
        }
      }
    }

    setTokens(tokens)
    setStateUpdate((stateUpdate) => stateUpdate + 1)
  }, [tokens, balances, availableChains])

  const hasSufficientBalance = () => {
    if (!fromTokenAddress || !fromChainKey) {
      return true
    }

    return depositAmount.lte(getBalance(balances, fromChainKey, fromTokenAddress))
  }

  const hasSufficientGasBalanceOnStartChain = (route?: RouteType) => {
    if (!route) {
      return true
    }

    const fromChain = getChainById(route.fromChainId)
    const token = findDefaultToken(fromChain.coin, fromChain.id)
    const balance = getBalance(balances, fromChain.key, token.address)

    const requiredAmount = route.steps
      .filter((step) => step.action.fromChainId === route.fromChainId)
      .map(
        (step) =>
          step.estimate.gasCosts &&
          step.estimate.gasCosts.length &&
          step.estimate.gasCosts[0].amount,
      )
      .map((amount) => new BigNumber(amount || '0'))
      .reduce((a, b) => a.plus(b), new BigNumber(0))
      .shiftedBy(-18)
    return !balance.isZero() && balance.gte(requiredAmount)
  }

  const hasSufficientGasBalanceOnCrossChain = (route?: RouteType) => {
    if (!route) {
      return true
    }
    const lastStep = route.steps[route.steps.length - 1]
    if (!isSwapStep(lastStep)) {
      return true
    }

    const crossChain = getChainById(lastStep.action.fromChainId)
    const token = findDefaultToken(crossChain.coin, crossChain.id)
    const balance = getBalance(balances, crossChain.key, token.address)

    const gasEstimate =
      lastStep.estimate.gasCosts &&
      lastStep.estimate.gasCosts.length &&
      lastStep.estimate.gasCosts[0].amount
    const requiredAmount = new BigNumber(gasEstimate || 0).shiftedBy(-18)
    return !balance.isZero() && balance.gte(requiredAmount)
  }

  const findToken = useCallback(
    (chainKey: ChainKey, tokenId: string) => {
      const token = tokens[chainKey].find((token) => token.address === tokenId)
      if (!token) {
        throw new Error('Token not found')
      }
      return token
    },
    [tokens],
  )

  useEffect(() => {
    const getTransferRoutes = async () => {
      setRoutes([])
      setHighlightedIndex(-1)
      setNoRoutesAvailable(false)

      if (depositAmount.gt(0) && fromChainKey && fromTokenAddress && toChainKey && toTokenAddress) {
        setRoutesLoading(true)
        setActiveTransactionInfoTabKey('1')
        const fromToken = findToken(fromChainKey, fromTokenAddress)
        const toToken = findToken(toChainKey, toTokenAddress)
        const request: RoutesRequest = {
          fromChainId: fromToken.chainId,
          fromAmount: new BigNumber(depositAmount).shiftedBy(fromToken.decimals).toFixed(0),
          fromTokenAddress,
          toChainId: toToken.chainId,
          toTokenAddress,
          fromAddress: web3.account || undefined,
          toAddress: web3.account || undefined,
          options: {
            order: optionOrder,
            slippage: optionSlippage / 100,
            bridges: {
              allow: optionEnabledBridges,
            },
            exchanges: {
              allow: optionEnabledExchanges,
            },
          },
        }

        const id = uuid()
        try {
          currentRouteCallId = id
          const result = await LiFi.getRoutes(request)
          setRouteCallResult({ result, id })
        } catch {
          if (id === currentRouteCallId || !currentRouteCallId) {
            setNoRoutesAvailable(true)
            setRoutesLoading(false)
          }
        }
      }
    }

    getTransferRoutes()
  }, [
    depositAmount,
    fromChainKey,
    fromTokenAddress,
    toChainKey,
    toTokenAddress,
    optionOrder,
    optionSlippage,
    optionEnabledBridges,
    optionEnabledExchanges,
    findToken,
  ])

  // set route call results
  useEffect(() => {
    if (routeCallResult) {
      const { result, id } = routeCallResult
      if (id === currentRouteCallId) {
        setRoutes(result.routes)
        setHighlightedIndex(result.routes.length === 0 ? -1 : 0)
        setNoRoutesAvailable(result.routes.length === 0)
        setRoutesLoading(false)
        transactionInfoRef.current?.scrollIntoView({ behavior: 'smooth' })
        setActiveTransactionInfoTabKey('1')
      }
    }
  }, [routeCallResult, currentRouteCallId])

  const openModal = () => {
    // deepClone to open new modal without execution info of previous transfer using same route card
    setSelectedRoute(deepClone(routes[highlightedIndex]))
  }

  const switchChain = async (chainId: number) => {
    if (!web3.account) {
      return
    }
    if (isWalletConnectWallet(web3.account)) {
      setShowWalletConnectChainSwitchModal({ show: true, chainId })
      return
    }
    await switchChainMetaMask(chainId)
  }

  const submitButton = () => {
    if (!active && isWalletDeactivated(web3.account)) {
      return (
        <Button
          disabled={true}
          shape="round"
          type="primary"
          icon={<LoadingOutlined />}
          size={'large'}></Button>
      )
    }
    if (!web3.account) {
      return <ConnectButton size={'large'} />
    }
    if (fromChainKey && web3.chainId !== getChainByKey(fromChainKey).id) {
      const fromChain = getChainByKey(fromChainKey)
      return (
        <Button
          shape="round"
          type="primary"
          icon={<SwapOutlined />}
          size={'large'}
          htmlType="submit"
          onClick={() => switchChain(fromChain.id)}>
          Switch Network to {fromChain.name}
        </Button>
      )
    }
    if (routesLoading) {
      return (
        <Button
          disabled={true}
          shape="round"
          type="primary"
          icon={<SyncOutlined spin />}
          size={'large'}>
          Searching Routes...
        </Button>
      )
    }
    if (noRoutesAvailable) {
      return (
        <Button disabled={true} shape="round" type="primary" size={'large'}>
          No Route Found
        </Button>
      )
    }
    if (!hasSufficientGasBalanceOnStartChain(routes[highlightedIndex])) {
      return (
        <Button disabled={true} shape="round" type="primary" size={'large'}>
          Insufficient Gas on Start Chain
        </Button>
      )
    }
    if (!hasSufficientGasBalanceOnCrossChain(routes[highlightedIndex])) {
      return (
        <Tooltip title="The selected route requires a swap on the chain you are tranferring to. You need to have gas on that chain to pay for the transaction there.">
          <Button disabled={true} shape="round" type="primary" size={'large'}>
            Insufficient Gas on Destination Chain
          </Button>
        </Tooltip>
      )
    }
    if (!hasSufficientBalance()) {
      return (
        <Button disabled={true} shape="round" type="primary" size={'large'}>
          Insufficient Funds
        </Button>
      )
    }
    const fromAmountUSD = new BigNumber(routes[highlightedIndex]?.fromAmountUSD)
    const toAmountUSD = new BigNumber(routes[highlightedIndex]?.toAmountUSD)

    const gasCostUSD = new BigNumber(routes[highlightedIndex]?.gasCostUSD || -1) // gasprices might be to low for correct USD /Cents rounding so might end up being 0.00

    const allValuesAvailable =
      !fromAmountUSD.isZero() && !toAmountUSD.isZero() && !gasCostUSD.isNegative()

    const totalExpenditure = gasCostUSD.isNegative()
      ? fromAmountUSD
      : fromAmountUSD.plus(gasCostUSD)
    const amountReceivedPercentage = toAmountUSD.dividedBy(totalExpenditure)
    const receivedAmountTooLow = amountReceivedPercentage.isLessThan(TOTAL_SLIPPAGE_GUARD_MODAL)

    const swapButton = (clickHandler?: Function) => {
      return (
        <Button
          disabled={highlightedIndex === -1}
          shape="round"
          type="primary"
          icon={<SwapOutlined />}
          size={'large'}
          onClick={() => clickHandler?.()}>
          Swap
        </Button>
      )
    }
    const popoverContent = (
      <div
        style={{
          maxWidth: '100px !important',
        }}>
        {allValuesAvailable && receivedAmountTooLow ? (
          <Typography.Paragraph>
            The value of the received tokens is significantly lower than the cost required to
            execute the transaction. Do you still want to proceed?
          </Typography.Paragraph>
        ) : !allValuesAvailable && receivedAmountTooLow ? (
          <Typography.Paragraph>
            The value of the received tokens is significantly lower than the cost required to
            execute the transaction. Also, we could not fetch the FIAT price of one or more of the
            listed values. Do you still want to proceed?
          </Typography.Paragraph>
        ) : (
          <Typography.Paragraph>
            We could not fetch the FIAT price of one or more of the listed values. Do you still want
            to proceed?
          </Typography.Paragraph>
        )}
        <Typography.Paragraph>
          Swapped token value: {!fromAmountUSD.isZero() ? `${fromAmountUSD.toFixed(2)} USD` : '~'}{' '}
          <br />
          Gas costs: {!gasCostUSD.isNegative() ? `${gasCostUSD.toFixed(2)} USD` : '~'} <br />
          Received token value: {!toAmountUSD.isZero() ? `${toAmountUSD.toFixed(2)} USD` : '~'}
        </Typography.Paragraph>
      </div>
    )
    return receivedAmountTooLow || !allValuesAvailable ? (
      <Popconfirm onConfirm={() => openModal()} title={popoverContent}>
        {swapButton()}
      </Popconfirm>
    ) : (
      swapButton(openModal)
    )
  }

  return (
    <Content
      className="site-layout site-layout-swap"
      style={{
        minHeight: 'calc(100vh - 64px)',
        marginTop: '64px',
      }}>
      <div className="swap-view">
        <Row gutter={[16, 96]} style={{ paddingTop: 48 }} justify="space-around">
          <Col sm={23} lg={23} xl={10} className="swap-form">
            <div className="swap-input">
              <Row>
                <Title className="swap-title" level={4}>
                  Please Specify Your Transaction
                </Title>
              </Row>

              <Form>
                <SwapForm
                  depositChain={fromChainKey}
                  setDepositChain={setFromChainKey}
                  depositToken={fromTokenAddress}
                  setDepositToken={setFromTokenAddress}
                  depositAmount={depositAmount}
                  setDepositAmount={setDepositAmount}
                  withdrawChain={toChainKey}
                  setWithdrawChain={setToChainKey}
                  withdrawToken={toTokenAddress}
                  setWithdrawToken={setToTokenAddress}
                  withdrawAmount={withdrawAmount}
                  setWithdrawAmount={setWithdrawAmount}
                  estimatedWithdrawAmount={getSelectedWithdraw().estimate}
                  estimatedMinWithdrawAmount={getSelectedWithdraw().min}
                  availableChains={availableChains}
                  tokens={tokens}
                  balances={balances}
                  allowSameChains={true}
                />
                <span>
                  {/* Bridge Prio */}
                  <Row justify="center" style={{ marginTop: 16 }}>
                    <Form.Item name="bridgePrioritization" label="Bridge Prioritization">
                      <Select
                        placeholder="Recommended"
                        value={optionOrder}
                        onChange={(v) => setOptionOrder(v)}
                        style={{
                          width: '100%',
                        }}>
                        {availableOrders.map((orderOption) => (
                          <Select.Option
                            key={orderOption.key}
                            value={orderOption.key}
                            data-label={orderOption.name}>
                            {orderOption.name}
                          </Select.Option>
                        ))}
                      </Select>
                    </Form.Item>
                  </Row>
                  {/* Disclaimer
                  <Row style={{ marginTop }} justify={'center'} className="beta-disclaimer">
                    <Typography.Text type="danger" style={{ textAlign: 'center' }}>
                      Beta product - use at own risk.
                    </Typography.Text>
                  </Row> */}
                  <Row style={{ marginTop: 24 }} justify={'center'}>
                    {submitButton()}
                  </Row>
                  {/* Advanced Options */}
                  <Row justify={'center'} style={{ marginTop: 16 }}>
                    <Collapse ghost style={{ width: '100%' }}>
                      <Collapse.Panel header={`Advanced Options`} key="1">
                        Bridge Prioritization
                        <div>
                          <Select
                            placeholder="Select Order"
                            value={optionOrder}
                            onChange={(v) => setOptionOrder(v)}
                            style={{
                              width: '100%',
                            }}>
                            {availableOrders.map((orderOption) => (
                              <Select.Option
                                key={orderOption.key}
                                value={orderOption.key}
                                data-label={orderOption.name}>
                                {orderOption.name}
                              </Select.Option>
                            ))}
                          </Select>
                        </div>
                        Slippage
                        <div>
                          <InputNumber
                            defaultValue={optionSlippage}
                            min={0}
                            max={100}
                            formatter={(value) => `${value}%`}
                            parser={(value) => parseFloat(value ? value.replace('%', '') : '')}
                            onChange={setOptionSlippage}
                            style={{
                              border: '1px solid #d9d9d9',
                              width: '100%',
                            }}
                          />
                        </div>
                        Infinite Approval
                        <div>
                          <Checkbox
                            checked={optionInfiniteApproval}
                            onChange={(e) => setOptionInfiniteApproval(e.target.checked)}>
                            Activate Infinite Approval
                          </Checkbox>
                        </div>
                        Bridges
                        <div>
                          <Select
                            mode="multiple"
                            placeholder="Select enabled bridges"
                            value={optionEnabledBridges}
                            onChange={setOptionEnabledBridges}
                            style={{
                              borderRadius: 6,
                              width: '100%',
                            }}>
                            {availableBridges.map((bridge) => (
                              <Select.Option key={bridge} value={bridge}>
                                {bridge}
                              </Select.Option>
                            ))}
                          </Select>
                        </div>
                        Exchanges
                        <div>
                          <Select
                            mode="multiple"
                            placeholder="Select enabled exchanges"
                            value={optionEnabledExchanges}
                            onChange={setOptionEnabledExchanges}
                            style={{
                              borderRadius: 6,
                              width: '100%',
                            }}>
                            {availableExchanges.map((exchange) => (
                              <Select.Option key={exchange} value={exchange}>
                                {exchange}
                              </Select.Option>
                            ))}
                          </Select>
                        </div>
                      </Collapse.Panel>
                    </Collapse>
                  </Row>
                </span>
              </Form>
            </div>
          </Col>

          <Col sm={23} lg={23} xl={14}>
            <div ref={transactionInfoRef}>
              <Tabs
                style={{ width: '90%' }}
                defaultActiveKey={activeRoutes.length ? '2' : historicalRoutes.length ? '3' : '1'}
                activeKey={activeTransactionInfoTabKey}
                onTabClick={(key: string) => setActiveTransactionInfoTabKey(key)}>
                <TabPane tab={`Available Routes (${routes.length})`} key="1">
                  {routesLoading || noRoutesAvailable || routes.length ? (
                    <RouteList
                      highlightedIndex={highlightedIndex}
                      routes={routes}
                      routesLoading={routesLoading}
                      noRoutesAvailable={noRoutesAvailable}
                      setHighlightedIndex={setHighlightedIndex}
                    />
                  ) : (
                    <Row style={{ paddingTop: 48 }}>
                      <Typography.Title level={4} disabled>
                        To get available routes, input your desired tokens to swap.
                      </Typography.Title>
                    </Row>
                  )}
                </TabPane>

                <TabPane
                  tab={`Active Transfers (${activeRoutes.length})`}
                  disabled={!activeRoutes.length}
                  key="2"
                  style={{ overflowX: 'scroll' }}>
                  {!!activeRoutes.length && (
                    <TransactionsTable
                      routes={activeRoutes}
                      selectRoute={(route: RouteType) => setSelectedRoute(route)}
                      deleteRoute={(route: RouteType) => {
                        LiFi.stopExecution(route)
                        deleteRoute(route)
                        setActiveRoutes(readActiveRoutes())
                      }}
                    />
                  )}
                </TabPane>

                <TabPane
                  tab={`Historical Transfers (${historicalRoutes.length})`}
                  disabled={!historicalRoutes.length}
                  key="3"
                  style={{ overflowX: 'scroll' }}>
                  {!!historicalRoutes.length && (
                    <TransactionsTable
                      routes={historicalRoutes}
                      selectRoute={() => {}}
                      deleteRoute={(route: RouteType) => {
                        LiFi.stopExecution(route)
                        deleteRoute(route)
                        setHistoricalRoutes(readHistoricalRoutes())
                      }}
                      historical={true}
                    />
                  )}
                </TabPane>
              </Tabs>
            </div>
          </Col>
        </Row>
      </div>

      {selectedRoute && !!selectedRoute.steps.length && (
        <Modal
          className="swapModal"
          visible={selectedRoute.steps.length > 0}
          onOk={() => {
            LiFi.moveExecutionToBackground(selectedRoute)
            resetForegroundRoute()
            setSelectedRoute(undefined)
            updateBalances()
          }}
          onCancel={() => {
            LiFi.moveExecutionToBackground(selectedRoute)
            resetForegroundRoute()

            setSelectedRoute(undefined)
            updateBalances()
          }}
          destroyOnClose={true}
          width={700}
          footer={null}>
          <Swapping
            route={selectedRoute}
            settings={{
              infiniteApproval: optionInfiniteApproval,
            }}
            updateRoute={() => {
              setActiveRoutes(readActiveRoutes())
              setHistoricalRoutes(readHistoricalRoutes())
            }}
            onSwapDone={() => {
              resetForegroundRoute()
              setActiveRoutes(readActiveRoutes())
              setHistoricalRoutes(readHistoricalRoutes())
              updateBalances()
            }}></Swapping>
        </Modal>
      )}

      <Modal
        className="wallet-selection-modal"
        visible={showWalletConnectChainSwitchModal.show}
        onOk={() => setShowWalletConnectChainSwitchModal({ show: false, chainId: 1 })}
        onCancel={() => setShowWalletConnectChainSwitchModal({ show: false, chainId: 1 })}
        footer={null}>
        <WalletConnectChainSwitchModal
          chainId={showWalletConnectChainSwitchModal.chainId}
          okHandler={() => {
            setShowWalletConnectChainSwitchModal({ show: false, chainId: 1 })
          }}
        />
      </Modal>
    </Content>
  )
}

export default Swap
