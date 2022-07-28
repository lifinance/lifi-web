import './SwapEtherspotKlimaZap.css'

import { ArrowRightOutlined, LoadingOutlined, SwapOutlined, SyncOutlined } from '@ant-design/icons'
import { Web3Provider } from '@ethersproject/providers'
import { useWeb3React } from '@web3-react/core'
import {
  Button,
  Checkbox,
  Col,
  Collapse,
  Divider,
  Form,
  InputNumber,
  Modal,
  Row,
  Select,
  Tooltip,
  Typography,
} from 'antd'
import { Content } from 'antd/lib/layout/layout'
import Paragraph from 'antd/lib/typography/Paragraph'
import Title from 'antd/lib/typography/Title'
import BigNumber from 'bignumber.js'
import { ethers } from 'ethers'
import { NetworkNames, Sdk, Web3WalletProvider } from 'etherspot'
import { createBrowserHistory } from 'history'
import { animate, stagger } from 'motion'
import QueryString from 'qs'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { v4 as uuid } from 'uuid'

import { LifiTeam } from '../assets/Li.Fi/LiFiTeam'
import { PoweredByLiFi } from '../assets/Li.Fi/poweredByLiFi'
import { Etherspot } from '../assets/misc/etherspot'
import { etherspotSupportedChains, TOUCAN_BCT_ADDRESS } from '../constants'
import { useMetatags } from '../hooks/useMetatags'
import LiFi from '../LiFi'
import { useChainsTokensTools } from '../providers/chainsTokensToolsProvider'
import { ToSectionCarbonOffsetProvider } from '../providers/ToSectionCarbonOffsetProvider'
import { getFeeTransferTransactionBasedOnAmount } from '../services/etherspotTxService'
import { readActiveRoutes, readHistoricalRoutes, storeRoute } from '../services/localStorage'
import { switchChain } from '../services/metamask'
import { loadTokenListAsTokens } from '../services/tokenListService'
import {
  deepClone,
  formatTokenAmountOnly,
  getBalance,
  isWalletDeactivated,
} from '../services/utils'
import {
  Chain,
  ChainId,
  ChainKey,
  CoinKey,
  ExchangeTool,
  ExtendedRoute,
  ExtendedRouteOptional,
  findDefaultToken,
  getChainById,
  getChainByKey,
  isSwapStep,
  Route as RouteType,
  RoutesRequest,
  Step,
  SwapPageStartParams,
  Token,
  TokenAmount,
  TokenWithAmounts,
} from '../types'
import forest from './../assets/misc/forest.jpg'
import { ResidualRouteCarbonOffsetModal } from './ResidualRouteSwappingModal/ResidualRouteCarbonOffsetModal'
import SwapForm from './SwapForm/SwapForm'
import { ToSectionCarbonOffset } from './SwapForm/SwapFormToSections/ToSectionCarbonOffset'
import SwappingCarbonOffset from './SwappingEtherspot/SwappingCarbonOffset'
import ConnectButton from './web3/ConnectButton'
import { getInjectedConnector } from './web3/connectors'

const TOKEN_POLYGON_USDC = findDefaultToken(CoinKey.USDC, ChainId.POL)
const history = createBrowserHistory()
let currentRouteCallId: string
const allowedDex = ExchangeTool.zerox

const fadeInAnimation = (element: React.MutableRefObject<HTMLDivElement | null>) => {
  setTimeout(() => {
    const nodes = element.current?.childNodes
    if (nodes) {
      animate(
        nodes as NodeListOf<Element>,
        {
          y: ['50px', '0px'],
          opacity: [0, 1],
        },
        {
          delay: stagger(0.2),
          duration: 0.5,
          easing: 'ease-in-out',
        },
      )
    }
  }, 0)
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

interface TokenAmountList {
  [ChainKey: string]: Array<TokenWithAmounts>
}

const Swap = () => {
  useMetatags({
    title: 'LI.FI - Carbon Offset',
  })
  const chainsTokensTools = useChainsTokensTools()

  // chains
  const [availableChains, setAvailableChains] = useState<Chain[]>(chainsTokensTools.chains)

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [unused, setStateUpdate] = useState<number>(0)

  // From
  const [fromChainKey, setFromChainKey] = useState<ChainKey | undefined>()
  const [depositAmount, setDepositAmount] = useState<BigNumber>(new BigNumber(0))
  const [fromTokenAddress, setFromTokenAddress] = useState<string | undefined>()
  const [toChainKey] = useState<ChainKey>(ChainKey.POL)
  const [withdrawAmount, setWithdrawAmount] = useState<BigNumber>(new BigNumber(Infinity))
  const [toTokenAddress] = useState<string | undefined>(TOKEN_POLYGON_USDC.address)
  const [tokens, setTokens] = useState<TokenAmountList>(chainsTokensTools.tokens)
  const [refreshTokens, setRefreshTokens] = useState<boolean>(false)
  const [balances, setBalances] = useState<{ [ChainKey: string]: Array<TokenAmount> }>()
  const [refreshBalances, setRefreshBalances] = useState<boolean>(true)
  const [routeCallResult, setRouteCallResult] = useState<{
    lifiRoute: RouteType
    gasStep: Step
    stakingStep: Step
    id: string
  }>()

  // Options
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
  const [route, setRoute] = useState<ExtendedRoute>({} as any)
  const [routesLoading, setRoutesLoading] = useState<boolean>(false)
  const [noRoutesAvailable, setNoRoutesAvailable] = useState<boolean>(false)
  const [selectedRoute, setSelectedRoute] = useState<ExtendedRoute | undefined>()
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1)
  const [activeRoutes, setActiveRoutes] = useState<Array<RouteType>>(readActiveRoutes())
  const [, setHistoricalRoutes] = useState<Array<RouteType>>(readHistoricalRoutes())
  const [residualRoute, setResidualRoute] = useState<ExtendedRouteOptional>()
  // Misc
  const [restartedOnPageLoad, setRestartedOnPageLoad] = useState<boolean>(false)
  const [balancePollingStarted, setBalancePollingStarted] = useState<boolean>(false)
  const [startParamsDefined, setStartParamsDefined] = useState<boolean>(false)

  const [tokenPolygonBCT, setTokenPolygonBCT] = useState<Token>()
  const tokensAndChainsSet = useMemo(
    () => availableChains.length !== 0 && Object.keys(tokens).length !== 0,
    [tokens, availableChains],
  )

  // Wallet
  const web3 = useWeb3React<Web3Provider>()
  const { active, account, library, chainId } = useWeb3React()
  const [etherSpotSDK, setEtherSpotSDK] = useState<Sdk>()
  const [etherspotWalletBalance, setEtherspotWalletBalance] = useState<BigNumber>()

  // setup etherspot sdk
  useEffect(() => {
    const etherspotSDKSetup = async () => {
      // TODO: try generalized connector from web3 object
      const connector = await getInjectedConnector()
      const provider = await Web3WalletProvider.connect(await connector.getProvider())
      const sdk = new Sdk(provider)
      sdk.services.networkService.switchNetwork(NetworkNames.Matic)
      await sdk.computeContractAccount({
        sync: false,
      })
      setEtherSpotSDK(sdk)
    }

    if (active && account && library && chainId && etherspotSupportedChains.includes(chainId)) {
      etherspotSDKSetup()
    }
  }, [active, account, library, chainId])

  // Check Etherspot Wallet balance
  useEffect(() => {
    const checkEtherspotWalletBalance = async (wallet: string) => {
      const balance = await LiFi.getTokenBalance(wallet, TOKEN_POLYGON_USDC)
      const amount = new BigNumber(balance?.amount || 0)
      if (amount.gte(0.3)) {
        setEtherspotWalletBalance(amount)
      } else {
        setEtherspotWalletBalance(undefined)
        return
      }
      const amountUsdc = ethers.BigNumber.from(
        amount.shiftedBy(TOKEN_POLYGON_USDC.decimals).toString(),
      )
      const { feeAmount } = await getFeeTransferTransactionBasedOnAmount(
        TOKEN_POLYGON_USDC,
        amountUsdc,
      )
      const amountUsdcToMatic = ethers.utils.parseUnits('0.2', TOKEN_POLYGON_USDC.decimals)
      const amountUsdcToCarbon = amountUsdc.sub(amountUsdcToMatic).sub(feeAmount)

      const gasStep = calculateFinalGasStep(amountUsdcToMatic.toString())
      const stakingStep = calculateFinalStakingStep(amountUsdcToCarbon.toString())
      const quotes = await Promise.all([gasStep, stakingStep])

      const residualRoute: ExtendedRouteOptional = {
        gasStep: quotes[0],
        stakingStep: quotes[1],
      }
      if (residualRoute.gasStep && residualRoute.stakingStep) {
        setResidualRoute(residualRoute)
      }
    }
    if (etherSpotSDK?.state.accountAddress) {
      checkEtherspotWalletBalance(etherSpotSDK.state.accountAddress)
    }
  }, [etherSpotSDK, tokenPolygonBCT])

  // Elements used for animations
  const routeCards = useRef<HTMLDivElement | null>(null)

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
    const limitedChains = chainsTokensTools.chains.filter((chain) => {
      return etherspotSupportedChains.includes(chain.id)
    })
    setAvailableChains(limitedChains)
  }, [chainsTokensTools.chains])

  //get tokens
  useEffect(() => {
    setTokens(chainsTokensTools.tokens)
    const loadAdditionalToken = async () => {
      const tokenBCT = await LiFi.getToken(ChainId.POL, TOUCAN_BCT_ADDRESS)!
      setTokenPolygonBCT(tokenBCT)
    }
    loadAdditionalToken()
  }, [chainsTokensTools.tokens])

  //get tools
  useEffect(() => {
    setAvailableExchanges(chainsTokensTools.bridges)
    setOptionEnabledExchanges(chainsTokensTools.exchanges)
    setAvailableBridges(chainsTokensTools.bridges)
    setOptionEnabledBridges(chainsTokensTools.bridges)
  }, [chainsTokensTools.bridges, chainsTokensTools.exchanges])

  useEffect(() => {
    if (tokensAndChainsSet) {
      setRefreshBalances(true)
    }
  }, [availableChains, tokens])

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
      setStartParamsDefined(true)
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
        pathname: '/showcase/carbon-offset',
        search,
      })
    }
  }, [fromChainKey, fromTokenAddress, toChainKey, depositAmount, startParamsDefined])

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
        LiFi.getTokenBalances(web3.account!, tokenList).then((portfolio: TokenAmount[]) => {
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
      setRoute({} as any)
      setHighlightedIndex(-1)
      setNoRoutesAvailable(false)

      if (
        depositAmount.gt(0) &&
        fromChainKey &&
        fromTokenAddress &&
        toChainKey &&
        toTokenAddress &&
        etherSpotSDK?.state.accountAddress
      ) {
        setRoutesLoading(true)
        const fromToken = findToken(fromChainKey, fromTokenAddress)
        const toToken = findToken(toChainKey, toTokenAddress)
        const request: RoutesRequest = {
          fromChainId: fromToken.chainId,
          fromAmount: new BigNumber(depositAmount).shiftedBy(fromToken.decimals).toFixed(0),
          fromTokenAddress,
          toChainId: toToken.chainId,
          toTokenAddress,
          fromAddress: web3.account || undefined,
          toAddress: etherSpotSDK.state.accountAddress,
          options: {
            integrator: 'lifi-etherspot',
            slippage: optionSlippage / 100,
            allowSwitchChain: false, // This is important for fixed recipients
            bridges: {
              allow: optionEnabledBridges,
              deny: ['multichain'],
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
          const amountUsdc = ethers.BigNumber.from(result.routes[0].toAmountMin)
          const { feeAmount } = await getFeeTransferTransactionBasedOnAmount(
            TOKEN_POLYGON_USDC,
            amountUsdc,
          )
          const amountUsdcToMatic = ethers.utils.parseUnits('0.2', TOKEN_POLYGON_USDC.decimals)
          const amountUsdcToCarbon = amountUsdc.sub(amountUsdcToMatic).sub(feeAmount)

          const gasStep = calculateFinalGasStep(amountUsdcToMatic.toString())
          const stakingStep = calculateFinalStakingStep(amountUsdcToCarbon.toString())
          const additionalQuotes = await Promise.all([gasStep, stakingStep])

          setRouteCallResult({
            lifiRoute: result.routes[0],
            gasStep: additionalQuotes[0],
            stakingStep: additionalQuotes[1],
            id,
          })
        } catch (e) {
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
    optionSlippage,
    optionEnabledBridges,
    optionEnabledExchanges,
    findToken,
    etherSpotSDK?.state.accountAddress,
  ])

  // set route call results
  useEffect(() => {
    if (routeCallResult) {
      const { lifiRoute, gasStep, stakingStep, id } = routeCallResult

      if (id === currentRouteCallId) {
        setRoute({ lifiRoute, gasStep, stakingStep })
        fadeInAnimation(routeCards)
        setHighlightedIndex(lifiRoute && gasStep && stakingStep ? 0 : -1)
        setNoRoutesAvailable(!lifiRoute || !gasStep || !stakingStep)
        setRoutesLoading(false)
      }
    }
  }, [routeCallResult, currentRouteCallId])

  const calculateFinalGasStep = async (amount: string) => {
    const polChain = getChainByKey(ChainKey.POL)

    const quoteUsdcToMatic = await LiFi.getQuote({
      fromChain: polChain.id,
      fromToken: TOKEN_POLYGON_USDC.address,
      fromAddress: etherSpotSDK?.state.accountAddress!,
      fromAmount: amount,
      toChain: polChain.id,
      toToken: (await LiFi.getToken(polChain.id, 'MATIC')!).address, // hardcode return gastoken
      slippage: 0.005,
      integrator: 'lifi-etherspot',
      allowExchanges: [allowedDex],
    })
    return quoteUsdcToMatic
  }
  const calculateFinalStakingStep = async (amount: string) => {
    const polChain = getChainByKey(ChainKey.POL)

    const quoteUsdcToBCT = await LiFi.getQuote({
      fromChain: polChain.id, // has been hardcoded in the routeRequest
      fromToken: TOKEN_POLYGON_USDC.address, // has been hardcoded in the routeRequest
      fromAddress: etherSpotSDK?.state.accountAddress!,
      fromAmount: amount,
      toChain: polChain.id,
      toToken: TOUCAN_BCT_ADDRESS,
      slippage: 0.005,
      integrator: 'lifi-etherspot',
      allowExchanges: [allowedDex],
    })
    return quoteUsdcToBCT
  }

  const openModal = () => {
    // deepClone to open new modal without execution info of previous transfer using same route card
    setSelectedRoute(deepClone(route))
    setHighlightedIndex(-1)
    setNoRoutesAvailable(false)
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
      return <ConnectButton size="large" />
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
    if (!hasSufficientGasBalanceOnStartChain(route.lifiRoute)) {
      return (
        <Button disabled={true} shape="round" type="primary" size={'large'}>
          Insufficient Gas on Start Chain
        </Button>
      )
    }
    if (!hasSufficientGasBalanceOnCrossChain(route.lifiRoute)) {
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

    return (
      <Button
        disabled={highlightedIndex === -1}
        shape="round"
        type="primary"
        size={'large'}
        onClick={() => openModal()}>
        Retire Carbon
      </Button>
    )
  }

  return (
    <ToSectionCarbonOffsetProvider>
      <Content
        className="site-layout-swap-ukraine"
        style={{
          minHeight: 'calc(100vh - 64px)',
          marginTop: '64px',
        }}>
        <div className="swap-view-ukraine">
          {/* Swap Form */}
          <Row className="ukraine-title-row">
            <Col
              xs={24}
              sm={24}
              md={24}
              lg={24}
              xl={12}
              className="ukraine-content-column title-row">
              <Title level={1}>Cross-chain carbon offsets</Title>
            </Col>
            <Col
              className="swap-form-etherspot swap-form-etherspot-carbon"
              xs={24}
              sm={24}
              md={24}
              lg={24}
              xl={12}
              style={{
                backgroundImage: `url(${forest})`,
              }}>
              <div
                className="swap-input-etherspot"
                style={{
                  margin: '0 auto',
                  maxWidth: 450,
                  borderRadius: 16,
                  padding: 32,
                }}>
                <Row>
                  <Title
                    className="swap-title"
                    level={3}
                    style={{ marginLeft: '0', fontWeight: 'bold', marginBottom: 16 }}>
                    Carbon offsets via BCT
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
                    withdrawChain={ChainKey.POL}
                    setWithdrawChain={() => {}}
                    withdrawToken={TOKEN_POLYGON_USDC.address}
                    setWithdrawToken={() => {}}
                    withdrawAmount={withdrawAmount}
                    setWithdrawAmount={setWithdrawAmount}
                    estimatedWithdrawAmount={'0'}
                    estimatedMinWithdrawAmount={'0'}
                    availableChains={availableChains}
                    tokens={tokens}
                    balances={balances}
                    allowSameChains={true}
                    fixedWithdraw={true}
                    fromSectionDesignator={'Use'}
                    toSectionDesignator={'To retire'}
                    alternativeToSection={
                      <ToSectionCarbonOffset
                        step={route?.stakingStep}
                        tokenPolygonBCT={tokenPolygonBCT}
                        routesLoading={routesLoading}
                      />
                    }
                  />
                  <span>
                    {/* Disclaimer */}
                    <Row justify={'center'} className="beta-disclaimer">
                      <Typography.Text type="danger" style={{ textAlign: 'center' }}>
                        Beta product - use at own risk.
                      </Typography.Text>
                    </Row>
                    <Row style={{ marginTop: 24 }} justify={'center'}>
                      {submitButton()}
                    </Row>
                    {/* Advanced Options */}
                    <Row justify={'center'} style={{ marginTop: '12px' }}>
                      <Collapse ghost style={{ width: '100%' }}>
                        <Collapse.Panel
                          header={`Advanced Options`}
                          style={{ maxHeight: 390, overflow: 'scroll' }}
                          key="1">
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
                                border: '1px solid rgba(0,0,0,0.25)',
                                borderRadius: 6,
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

              <div
                style={{
                  margin: '32px auto',
                  padding: '14px 20px 10px',
                  textAlign: 'center',
                  background: 'rgba(255, 255, 255, 0.69)',
                  borderRadius: 18,
                  cursor: 'pointer',
                }}>
                <a href="https://li.fi/" target="_blank" rel="nofollow noreferrer">
                  <PoweredByLiFi />
                </a>

                <span style={{ verticalAlign: 'super', margin: 8 }}>&</span>

                <a href="https://etherspot.io/" target="_blank" rel="nofollow noreferrer">
                  <Etherspot />
                </a>
              </div>
            </Col>
          </Row>

          <Row>
            <Col xs={24} sm={24} md={24} lg={24} xl={12} className="ukraine-content-column">
              <Title level={4}>
                LI.FI and Etherspot teams have joined hands to support cross-chain carbon offsets.
              </Title>
              <br />

              <Divider style={{ borderColor: 'black' }} />
              <Paragraph style={{ marginTop: 64 }}>
                <h2>What is happening here?</h2>
                We’re combining
                <ol>
                  <li>
                    LI.FI’s ability to perform <b>any-2-any cross-chain swaps</b> and
                  </li>
                  <li>
                    Etherspot’s smart contract wallet feature through which we can{' '}
                    <b>batch transactions and sign cross-chain transactions</b> without RPC switch,{' '}
                  </li>
                </ol>
                to <b>facilitate cross-chain carbon retirements</b> in just 3 steps which would
                normally be 9 steps on 3 different dapps. You can learn more about carbon offsetting
                by KlimaDAO here:{' '}
                <a
                  href="https://www.klimadao.finance/blog/the-promise-and-challenges-of-carbon-offsetting"
                  target="_blank"
                  rel="noreferrer">
                  The promise and challenges of carbon offsetting
                </a>
              </Paragraph>
              <Paragraph style={{ marginTop: 64 }}>
                <h2>What is happening in the background?</h2>
                When a cross-chain swap is completed via LI.FI, the asset is received on the
                counterfactual smart wallet that the user controls on Polygon. The user then
                executes a transaction that:
                <ol>
                  <li>Swaps USDC to MATIC.</li>
                  <li>Deploys the Smart Wallet.</li>
                  <li>
                    Calls the Klima DAO contract to retire carbon based on the{' '}
                    <a href="https://toucan.earth/" target="_blank" rel="noreferrer">
                      Toucan Protocol: Base Carbon Tonne Token.
                    </a>
                  </li>
                </ol>
                All in a single transaction on the destination chain, with no need to switch RPC
                networks and no need to have the gas token.
              </Paragraph>

              <Button
                className="btn-info-ukraine"
                shape="round"
                type="primary"
                size={'large'}
                onClick={() => {
                  window.open('https://etherspot.io/', '_blank')
                }}>
                Etherspot <ArrowRightOutlined />
              </Button>

              <Button
                className="btn-wallet-ukraine"
                shape="round"
                type="primary"
                size={'large'}
                onClick={() => {
                  window.open('https://www.klimadao.finance/', '_blank')
                }}>
                KlimaDAO <ArrowRightOutlined />
              </Button>
              <div
                onClick={() => window.open('https://li.fi', '_blank')}
                style={{ marginTop: 34, cursor: 'pointer' }}>
                <LifiTeam></LifiTeam>
              </div>
            </Col>
          </Row>
        </div>

        {selectedRoute && !!selectedRoute.lifiRoute.steps.length && (
          <Modal
            className="swapModal"
            visible={selectedRoute.lifiRoute.steps.length > 0}
            onOk={() => {
              setSelectedRoute(undefined)
              updateBalances()
            }}
            onCancel={() => {
              setSelectedRoute(undefined)
              updateBalances()
            }}
            destroyOnClose={true}
            maskClosable={false}
            width={700}
            footer={null}>
            <SwappingCarbonOffset
              fixedRecipient={true}
              route={selectedRoute}
              etherspot={etherSpotSDK}
              settings={{ infiniteApproval: optionInfiniteApproval }}
              updateRoute={() => {
                setActiveRoutes(readActiveRoutes())
                setHistoricalRoutes(readHistoricalRoutes())
              }}
              onSwapDone={() => {
                setActiveRoutes(readActiveRoutes())
                setHistoricalRoutes(readHistoricalRoutes())
                updateBalances()
              }}></SwappingCarbonOffset>
          </Modal>
        )}

        {!!etherspotWalletBalance && !!residualRoute && (
          <Modal
            onCancel={() => {
              setEtherspotWalletBalance(undefined)
              setResidualRoute(undefined)
            }}
            visible={!!etherspotWalletBalance && !!residualRoute}
            okText="Swap, stake and receive sKlima"
            footer={null}>
            <ResidualRouteCarbonOffsetModal
              etherSpotSDK={etherSpotSDK!}
              etherspotWalletBalance={etherspotWalletBalance}
              setEtherspotWalletBalance={setEtherspotWalletBalance}
              residualRoute={residualRoute}
              setResidualRoute={setResidualRoute}
            />
          </Modal>
        )}
      </Content>
    </ToSectionCarbonOffsetProvider>
  )
}

export default Swap
