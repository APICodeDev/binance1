import Foundation

struct AuthUser: Codable, Identifiable {
    let id: Int
    let email: String
    let username: String?
    let role: String
    let authType: String?
}

struct Position: Codable, Identifiable {
    let id: Int
    let symbol: String
    let positionType: String
    let amount: Double
    let quantity: Double
    let entryPrice: Double
    let stopLoss: Double
    let status: String
    let tradingMode: String
    let profitLossPercent: Double
    let profitLossFiat: Double
    let createdAt: String
    let closedAt: String?
    let origin: String?
    let timeframe: String?
    let commission: Double?
    let pricePrecision: Int?
}

struct SettingsPayload: Codable {
    let bot_enabled: String
    let custom_amount: String
    let last_entry_error: String
    let trading_mode: String
    let leverage_enabled: String
    let leverage_value: String
    let profit_sound_enabled: String
    let profit_sound_file: String
    let api_stop_mode: String
}

struct PositionsPayload: Codable {
    let open: [Position]
    let history: [Position]
    let totalPnl: Double
}

struct AccountOverviewPayload: Codable {
    struct ModeData: Codable {
        struct SummaryItem: Codable, Identifiable {
            var id: String { accountType }
            let accountType: String
            let usdtBalance: Double
            let btcBalance: Double
        }

        struct FuturesBucket: Codable, Identifiable {
            var id: String { "\(marginCoin)-\(accountEquity)" }
            let marginCoin: String
            let available: Double
            let locked: Double
            let accountEquity: Double
            let unrealizedPnl: Double
            let crossedMaxAvailable: Double
            let maxOpenPosAvailable: Double
        }

        struct SpotAsset: Codable, Identifiable {
            var id: String { coin }
            let coin: String
            let available: Double
            let frozen: Double
            let total: Double
        }

        struct FuturesContainer: Codable {
            let usdt: [FuturesBucket]
            let usdc: [FuturesBucket]
            let coin: [FuturesBucket]
        }

        let summary: [SummaryItem]
        let futures: FuturesContainer
        let spotAssets: [SpotAsset]
        let rawStatus: [String: Bool]
    }

    let demo: ModeData
    let live: ModeData
    let fetchedAt: String
}

struct StatsPayload: Codable {
    struct StatsMode: Codable {
        struct SourceByCount: Codable, Identifiable {
            var id: String { source }
            let source: String
            let totalCount: Int
            let winCount: Int
            let effectivenessPercent: Double
        }

        struct SourceByDuration: Codable, Identifiable {
            var id: String { source }
            let source: String
            let totalDurationMs: Double
            let winDurationMs: Double
            let effectivenessPercent: Double
        }

        struct SymbolByWins: Codable, Identifiable {
            var id: String { symbol }
            let symbol: String
            let totalCount: Int
            let winCount: Int
            let effectivenessPercent: Double
        }

        struct SymbolByProfit: Codable, Identifiable {
            var id: String { symbol }
            let symbol: String
            let totalCount: Int
            let profitAmount: Double
        }

        struct CountLabel: Codable, Identifiable {
            var id: String { label }
            let label: String
            let count: Int
        }

        let closedCount: Int
        let successCount: Int
        let failedCount: Int
        let successPercent: Double
        let failedPercent: Double
        let profitAmount: Double
        let lossAmount: Double
        let profitPercent: Double
        let lossPercent: Double
        let sourceByCount: [SourceByCount]
        let sourceByDuration: [SourceByDuration]
        let symbolByWins: [SymbolByWins]
        let symbolByProfit: [SymbolByProfit]
        let tradesByWeekday: [CountLabel]
        let tradesByHour: [CountLabel]
    }

    let demo: StatsMode
    let live: StatsMode
    let timestamp: String
}

struct ApiToken: Codable, Identifiable {
    let id: String
    let name: String
    let lastFour: String
    let isActive: Bool
    let createdAt: String
    let lastUsedAt: String?
    let expiresAt: String?
}

struct AuditUser: Codable {
    let email: String
    let username: String?
    let role: String
}

struct AuditLog: Codable, Identifiable {
    let id: Int
    let action: String
    let targetType: String?
    let targetId: String?
    let metadata: JSONValue?
    let createdAt: String
    let ipAddress: String?
    let userAgent: String?
    let user: AuditUser?
}

struct HeatmapPaperPayload: Codable {
    struct Summary: Codable {
        let closedCount: Int
        let totalPnl: Double
        let winCount: Int
        let lossCount: Int
    }

    struct Analytics: Codable {
        let closedCount: Int
        let winCount: Int
        let lossCount: Int
        let winRate: Double
        let targetHits: Int
        let stopHits: Int
    }

    struct PaperTrade: Codable, Identifiable {
        let id: Int
        let symbol: String
        let side: String
        let amount: Double
        let quantity: Double
        let entryPrice: Double
        let stopPrice: Double
        let targetPrice: Double
        let status: String
        let tradingMode: String
        let confidence: Double
        let source: String
        let timeframe: String?
        let reasons: [String]?
        let exitPrice: Double?
        let exitReason: String?
        let profitLossFiat: Double?
        let profitLossPercent: Double?
        let createdAt: String
        let updatedAt: String
        let closedAt: String?
    }

    let mode: String
    let open: [PaperTrade]
    let history: [PaperTrade]
    let summary: Summary
    let analytics: Analytics
}

struct BookmapSummary: Decodable {
    struct Composite: Decodable {
        let bestBid: Double?
        let bestAsk: Double?
        let mid: Double
        let spreadBps: Double?

        init(bestBid: Double? = nil, bestAsk: Double? = nil, mid: Double = 0, spreadBps: Double? = nil) {
            self.bestBid = bestBid
            self.bestAsk = bestAsk
            self.mid = mid
            self.spreadBps = spreadBps
        }
    }

    struct ExchangeSnapshot: Decodable, Identifiable {
        var id: String { exchange }
        let exchange: String
        let status: String
        let bestBid: Double?
        let bestAsk: Double?
        let spreadBps: Double?
        let lastUpdateAgeMs: Double?
        let isFresh: Bool
    }

    struct TapeTrade: Decodable, Identifiable {
        var id: String { "\(exchange)-\(timestamp)-\(price)" }
        let exchange: String
        let price: Double
        let size: Double
        let side: String
        let timestamp: Double
    }

    struct Tape: Decodable {
        let buyVolume: Double
        let sellVolume: Double
        let imbalance: Double
        let recentTrades: [TapeTrade]

        init(buyVolume: Double = 0, sellVolume: Double = 0, imbalance: Double = 0, recentTrades: [TapeTrade] = []) {
            self.buyVolume = buyVolume
            self.sellVolume = sellVolume
            self.imbalance = imbalance
            self.recentTrades = recentTrades
        }
    }

    struct Zone: Decodable, Identifiable {
        var id: String { "\(price)-\(side ?? "zone")" }
        let price: Double
        let totalSize: Double
        let totalNotional: Double
        let exchangeCount: Int
        let exchanges: [String]
        let distancePercent: Double
        let side: String?
    }

    struct PreSignal: Decodable {
        let actionable: Bool
        let bias: String
        let confidence: Double
        let entryPrice: Double?
        let stopPrice: Double?
        let targetPrice: Double?
        let rewardRisk: Double?
        let invalidation: String?
        let mode: String
        let reasons: [String]
        let createdAt: Double?
        let updatedAt: Double?
        let invalidatedAt: Double?
        let invalidationReason: String?
    }

    struct ZonesContainer: Decodable {
        let supports: [Zone]
        let resistances: [Zone]
    }

    let symbol: String
    let asOf: Double
    let lastPrice: Double?
    let composite: Composite
    let exchanges: [ExchangeSnapshot]
    let tape: Tape
    let supports: [Zone]
    let resistances: [Zone]
    let preSignal: PreSignal

    enum CodingKeys: String, CodingKey {
        case symbol
        case asOf
        case lastPrice
        case composite
        case exchanges
        case tape
        case supports
        case resistances
        case zones
        case preSignal
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        symbol = try container.decodeIfPresent(String.self, forKey: .symbol) ?? "UNKNOWN"
        asOf = try container.decodeIfPresent(Double.self, forKey: .asOf) ?? 0
        lastPrice = try container.decodeIfPresent(Double.self, forKey: .lastPrice)
        composite = try container.decodeIfPresent(Composite.self, forKey: .composite) ?? Composite()
        exchanges = try container.decodeIfPresent([ExchangeSnapshot].self, forKey: .exchanges) ?? []
        tape = try container.decodeIfPresent(Tape.self, forKey: .tape) ?? Tape()
        preSignal = try container.decodeIfPresent(PreSignal.self, forKey: .preSignal) ?? PreSignal(
            actionable: false,
            bias: "neutral",
            confidence: 0,
            entryPrice: nil,
            stopPrice: nil,
            targetPrice: nil,
            rewardRisk: nil,
            invalidation: nil,
            mode: "watch",
            reasons: [],
            createdAt: nil,
            updatedAt: nil,
            invalidatedAt: nil,
            invalidationReason: nil
        )

        if let zones = try container.decodeIfPresent(ZonesContainer.self, forKey: .zones) {
            supports = zones.supports
            resistances = zones.resistances
        } else {
            supports = try container.decodeIfPresent([Zone].self, forKey: .supports) ?? []
            resistances = try container.decodeIfPresent([Zone].self, forKey: .resistances) ?? []
        }
    }
}

struct LoginResponseWrapper: Codable {
    struct DataPayload: Codable {
        let user: AuthUser
        let authType: String?
    }

    let data: DataPayload?
}

struct AuthMeWrapper: Codable {
    struct DataPayload: Codable {
        let user: AuthUser
        let authType: String?
    }

    let data: DataPayload?
}

struct TokensResponse: Codable {
    struct DataPayload: Codable {
        let tokens: [ApiToken]
    }

    let data: DataPayload?
}

struct AuditResponse: Codable {
    struct DataPayload: Codable {
        let logs: [AuditLog]
    }

    let data: DataPayload?
}

struct OverviewResponse: Codable {
    let data: AccountOverviewPayload?
}

struct StatsResponse: Codable {
    let data: StatsPayload?
}

struct BookmapResponse: Decodable {
    let data: BookmapSummary?

    enum CodingKeys: String, CodingKey {
        case data
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let wrapped = try container.decodeIfPresent(BookmapSummary.self, forKey: .data) {
            data = wrapped
        } else {
            data = try? BookmapSummary(from: decoder)
        }
    }
}

struct HeatmapPaperResponse: Codable {
    let data: HeatmapPaperPayload?
}

struct SoundsResponse: Codable {
    struct DataPayload: Codable {
        let files: [String]
    }

    let data: DataPayload?
}

enum JSONValue: Codable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value):
            try container.encode(value)
        case .number(let value):
            try container.encode(value)
        case .bool(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .null:
            try container.encodeNil()
        }
    }
}
