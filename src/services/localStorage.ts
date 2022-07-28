import { Route, Status, WalletConnectInfo } from '../types'

const isSupported = () => {
  try {
    var itemBackup = localStorage.getItem('')
    localStorage.removeItem('')
    if (itemBackup === null) localStorage.removeItem('')
    else localStorage.setItem('', itemBackup)
    return true
  } catch (e) {
    return false
  }
}

const clearLocalStorage = () => {
  if (isSupported()) {
    localStorage.clear()
  }
}

const storeWallets = (wallets: Array<string>) => {
  if (isSupported()) {
    const lowerCaseWallets = wallets.map((address) => address.toLowerCase())
    localStorage.setItem('wallets', JSON.stringify(Array.from(new Set(lowerCaseWallets))))
  }
}

const readWallets = (): Array<string> => {
  if (!isSupported()) {
    return []
  }
  const walletsString = localStorage.getItem('wallets')
  if (walletsString) {
    try {
      return JSON.parse(walletsString)
    } catch (e) {
      return []
    }
  } else {
    return []
  }
}

const storeDeactivatedWallets = (wallets: string[]) => {
  if (isSupported()) {
    const lowerCaseWallets = wallets.map((address) => address.toLowerCase())
    localStorage.setItem(
      'deactivatedWallets',
      JSON.stringify(Array.from(new Set(lowerCaseWallets))),
    )
  }
}

const readDeactivatedWallets = (): Array<string> => {
  if (!isSupported()) {
    return []
  }
  const walletsString = localStorage.getItem('deactivatedWallets')
  if (walletsString) {
    try {
      return JSON.parse(walletsString)
    } catch (e) {
      return []
    }
  } else {
    return []
  }
}

const storeHideDisconnectPopup = (shouldHide: boolean) => {
  if (!isSupported()) return
  localStorage.setItem('hideDisconnetPopup', JSON.stringify(shouldHide))
}

const readHideDisconnectPopup = (): boolean => {
  if (!isSupported()) return false
  const shouldHideString = localStorage.getItem('hideDisconnetPopup')
  return JSON.parse(shouldHideString as string) === true
}

const storeHideAbout = (hide: boolean) => {
  if (isSupported()) {
    localStorage.setItem('nxtpHideDemo', hide ? 'true' : 'false')
  }
}

const readHideAbout = () => {
  if (!isSupported()) {
    return true
  }
  const value = localStorage.getItem('nxtpHideDemo')
  return !(value === 'false')
}

const storeRoute = (route: Route) => {
  if (!isSupported()) return
  const storedRoutes = readAllRoutes()
  let updatedRoutes: Route[]
  if (!storedRoutes.length) {
    updatedRoutes = [route]
  } else {
    let replaced = false
    updatedRoutes = storedRoutes.map((storedRoute) => {
      if (storedRoute.id === route.id) {
        storedRoute = route
        replaced = true
      }
      return storedRoute
    })
    if (!replaced) {
      updatedRoutes.push(route)
    }
  }

  localStorage.setItem('routes', JSON.stringify(updatedRoutes))
}

const storeForegroundRoute = (route: Route) => {
  if (!isSupported()) return
  localStorage.setItem('foregroundRoute', route.id)
}

const readForegroundRoute = () => {
  if (!isSupported()) return
  const id = localStorage.getItem('foregroundRoute')
  return id
}

const resetForegroundRoute = () => {
  if (!isSupported()) return
  localStorage.removeItem('foregroundRoute')
}
const deleteRoute = (route: Route) => {
  if (!isSupported() || !route) {
    return
  }
  const storedRoutes = readAllRoutes()
  const updatedRoutes = storedRoutes.filter((storedRoute) => storedRoute.id !== route.id)

  localStorage.setItem('routes', JSON.stringify(updatedRoutes))
}

const readAllRoutes = (): Array<Route> => {
  if (!isSupported()) {
    return [] as Array<Route>
  }
  const routeString = localStorage.getItem('routes')

  if (routeString) {
    try {
      const routes = JSON.parse(routeString) as Array<Route>
      return routes as Array<Route>
    } catch (e) {
      return [] as Array<Route>
    }
  } else {
    return [] as Array<Route>
  }
}

const sortRoutesByExecutionDate = (routes: Route[]): Route[] =>
  routes.sort((routeA, routeB) => {
    if (!routeA.steps[0].execution?.process.length) {
      return -1 // A doesn't have an execution, so move it to the top of the list
    }
    if (!routeB.steps[0].execution?.process.length) {
      return 1 // B doesn't have an execution, so move it to the top of the list
    }

    return (
      routeB.steps[0].execution.process[0].startedAt -
      routeA.steps[0].execution.process[0].startedAt
    )
  })

const HISTORICAL_STATI: Status[] = ['DONE', 'CANCELLED']

const readHistoricalRoutes = (): Array<Route> => {
  if (!isSupported()) {
    return [] as Array<Route>
  }
  const routes = readAllRoutes()
  const historicalRoutes = routes.filter((route) =>
    route.steps.every(
      (step) => step.execution?.status && HISTORICAL_STATI.includes(step.execution.status),
    ),
  )
  return sortRoutesByExecutionDate(historicalRoutes)
}

const readActiveRoutes = (): Array<Route> => {
  if (!isSupported()) {
    return [] as Array<Route>
  }
  const routes = readAllRoutes()
  const activeRoutes = routes.filter(
    (route) =>
      !route.steps.every(
        (step) => step.execution?.status && HISTORICAL_STATI.includes(step.execution.status),
      ),
  )

  return sortRoutesByExecutionDate(activeRoutes)
}
const isWalletConnectWallet = (wallet: string): boolean => {
  if (!isSupported() || !wallet) {
    return false
  }
  const walletConnectString = localStorage.getItem('walletconnect')
  if (!walletConnectString) {
    return false
  }
  const walletConnect = JSON.parse(walletConnectString)
  if (!walletConnect.accounts) {
    return false
  }

  const lowerCaseAddresses = walletConnect.accounts.map((account: string) => account.toLowerCase())
  return lowerCaseAddresses.includes(wallet.toLowerCase())
}

const readWalletConnectInfo = () => {
  if (!isSupported()) {
    return
  }
  const walletConnectInfoString = localStorage.getItem('walletconnect')
  if (!walletConnectInfoString) {
    return
  }
  const walletConnectInfo = JSON.parse(walletConnectInfoString)
  if (walletConnectInfo) {
    try {
      return walletConnectInfo as WalletConnectInfo
    } catch {
      return
    }
  }
  return
}

const storeWalletConnectInfo = (walletConnectInfo: WalletConnectInfo) => {
  if (!isSupported()) return
  localStorage.setItem('walletconnect', JSON.stringify(walletConnectInfo))
}

const deleteWalletConnectInfo = () => {
  if (!isSupported()) return
  localStorage.removeItem('walletconnect')
}

// TODO: Migrating old localStorage key. Can be removed after being deployed for a while (deployed on 17.12.2021)
const migrateOldlocalStorageKey = () => {
  if (!isSupported()) return
  const alreadyMigrated = localStorage.getItem('routes')
  if (alreadyMigrated) return

  const oldRoutes = localStorage.getItem('activeRoute')
  if (oldRoutes) {
    localStorage.setItem('routes', oldRoutes)
  }
  localStorage.removeItem('activeRoute')
}
migrateOldlocalStorageKey()

// TODO: Migrating and adding toolDetails. Can be removed after being deployed for a while (deployed on 20.05.2022)
const migrateToolDetails = () => {
  if (!isSupported()) return
  const oldRoutes = readAllRoutes()
  const updatedRoutes = oldRoutes.map((oldRoute) => {
    oldRoute.steps.map((step) => {
      if (step.toolDetails) {
        return step
      }
      step.toolDetails = { logoURI: '', name: step.tool, key: step.tool.split('-')[0] }
      return step
    })
    return oldRoute
  })
  localStorage.setItem('routes', JSON.stringify(updatedRoutes))
}

migrateToolDetails()

export {
  clearLocalStorage,
  deleteRoute,
  deleteWalletConnectInfo,
  isSupported,
  isWalletConnectWallet,
  readActiveRoutes,
  readDeactivatedWallets,
  readForegroundRoute,
  readHideAbout,
  readHideDisconnectPopup,
  readHistoricalRoutes,
  readWalletConnectInfo,
  readWallets,
  resetForegroundRoute,
  sortRoutesByExecutionDate,
  storeDeactivatedWallets,
  storeForegroundRoute,
  storeHideAbout,
  storeHideDisconnectPopup,
  storeRoute,
  storeWalletConnectInfo,
  storeWallets,
}
