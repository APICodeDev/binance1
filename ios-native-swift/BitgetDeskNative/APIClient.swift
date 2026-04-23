import Foundation

enum APIError: LocalizedError {
    case invalidURL
    case server(String)
    case unauthorized
    case transport(String)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid server URL."
        case .server(let message):
            return message
        case .unauthorized:
            return "Unauthorized. Please sign in again."
        case .transport(let message):
            return message
        case .decoding(let message):
            return message
        }
    }
}

final class APIClient {
    static let shared = APIClient()

    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .useDefaultKeys
        return decoder
    }()

    private func buildURL(baseURL: String, path: String) throws -> URL {
        let trimmedBaseURL = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedBaseURL: String
        if trimmedBaseURL.hasPrefix("http://") || trimmedBaseURL.hasPrefix("https://") {
            normalizedBaseURL = trimmedBaseURL
        } else {
            normalizedBaseURL = "https://\(trimmedBaseURL)"
        }

        let sanitizedBaseURL = normalizedBaseURL.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        let sanitizedPath = path.hasPrefix("/") ? path : "/\(path)"

        guard let url = URL(string: "\(sanitizedBaseURL)\(sanitizedPath)") else {
            throw APIError.invalidURL
        }

        return url
    }

    private func request<T: Decodable>(
        baseURL: String,
        path: String,
        method: String = "GET",
        body: Data? = nil,
        token: String? = nil,
        type: T.Type
    ) async throws -> T {
        let url = try buildURL(baseURL: baseURL, path: path)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let configuration = URLSessionConfiguration.default
        configuration.httpCookieAcceptPolicy = .always
        configuration.httpShouldSetCookies = true
        configuration.httpCookieStorage = HTTPCookieStorage.shared

        let session = URLSession(configuration: configuration)

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw APIError.transport("Invalid server response.")
            }

            if http.statusCode == 401 || http.statusCode == 403 {
                throw APIError.unauthorized
            }

            guard (200...299).contains(http.statusCode) else {
                if let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    let message = (payload["detail"] as? String) ?? (payload["message"] as? String) ?? "Request failed: \(http.statusCode)"
                    throw APIError.server(message)
                }
                throw APIError.server("Request failed: \(http.statusCode)")
            }

            do {
                return try decoder.decode(T.self, from: data)
            } catch let decodingError as DecodingError {
                throw APIError.decoding("Response decoding failed: \(describeDecodingError(decodingError))")
            } catch {
                throw APIError.decoding("Response decoding failed: \(error.localizedDescription)")
            }
        } catch let error as APIError {
            throw error
        } catch {
            throw APIError.transport(error.localizedDescription)
        }
    }

    private func requestVoid(
        baseURL: String,
        path: String,
        method: String = "POST",
        body: Data? = nil,
        token: String? = nil
    ) async throws {
        struct EmptyResponse: Decodable {}
        _ = try await request(baseURL: baseURL, path: path, method: method, body: body, token: token, type: EmptyResponse.self)
    }

    func login(baseURL: String, identifier: String, password: String) async throws -> (user: AuthUser, sessionToken: String?) {
        let body = try JSONEncoder().encode([
            "identifier": identifier,
            "password": password
        ])
        let response = try await request(baseURL: baseURL, path: "/api/auth/login", method: "POST", body: body, type: LoginResponseWrapper.self)
        guard let payload = response.data else {
            throw APIError.server("Login payload is empty.")
        }
        return (
            user: AuthUser(id: payload.user.id, email: payload.user.email, username: payload.user.username, role: payload.user.role, authType: payload.authType),
            sessionToken: payload.sessionToken
        )
    }

    func authMe(baseURL: String, token: String?) async throws -> AuthUser {
        let response = try await request(baseURL: baseURL, path: "/api/auth/me", token: token, type: AuthMeWrapper.self)
        guard let payload = response.data else {
            throw APIError.server("Session not found.")
        }
        return AuthUser(id: payload.user.id, email: payload.user.email, username: payload.user.username, role: payload.user.role, authType: payload.authType)
    }

    func logout(baseURL: String, token: String?) async {
        try? await requestVoid(baseURL: baseURL, path: "/api/auth/logout", method: "POST", token: token)
    }

    func getSettings(baseURL: String, token: String?) async throws -> SettingsPayload {
        try await request(baseURL: baseURL, path: "/api/settings", token: token, type: SettingsPayload.self)
    }

    func updateSettings(baseURL: String, token: String?, payload: [String: Any]) async throws {
        let body = try JSONSerialization.data(withJSONObject: payload)
        try await requestVoid(baseURL: baseURL, path: "/api/settings", method: "POST", body: body, token: token)
    }

    func getPositions(baseURL: String, token: String?, mode: String) async throws -> PositionsPayload {
        try await request(baseURL: baseURL, path: "/api/positions?mode=\(mode)", token: token, type: PositionsPayload.self)
    }

    func runMonitor(baseURL: String, token: String?, mode: String? = nil) async throws {
        let suffix: String
        if let mode, !mode.isEmpty {
            let encoded = mode.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? mode
            suffix = "?mode=\(encoded)"
        } else {
            suffix = ""
        }
        try await requestVoid(baseURL: baseURL, path: "/api/monitor\(suffix)", method: "GET", token: token)
    }

    func openPosition(baseURL: String, token: String?, payload: [String: Any]) async throws {
        let body = try JSONSerialization.data(withJSONObject: payload)
        try await requestVoid(baseURL: baseURL, path: "/api/entry", method: "POST", body: body, token: token)
    }

    func closePosition(baseURL: String, token: String?, id: Int) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["id": id])
        try await requestVoid(baseURL: baseURL, path: "/api/close", method: "POST", body: body, token: token)
    }

    func emergencyClose(baseURL: String, token: String?) async throws {
        try await requestVoid(baseURL: baseURL, path: "/api/emergency", method: "POST", token: token)
    }

    func getBookmap(baseURL: String, token: String?, symbol: String) async throws -> BookmapSummary {
        let encoded = symbol.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? symbol
        let response = try await request(baseURL: baseURL, path: "/api/bookmap?symbol=\(encoded)", token: token, type: BookmapResponse.self)
        guard let data = response.data else {
            throw APIError.server("Bookmap data is empty.")
        }
        return data
    }

    func getStats(baseURL: String, token: String?) async throws -> StatsPayload {
        let response = try await request(baseURL: baseURL, path: "/api/stats", token: token, type: StatsResponse.self)
        guard let data = response.data else {
            throw APIError.server("Stats data is empty.")
        }
        return data
    }

    func getHeatmapPaper(baseURL: String, token: String?) async throws -> HeatmapPaperPayload {
        let response = try await request(baseURL: baseURL, path: "/api/heatmap-paper", token: token, type: HeatmapPaperResponse.self)
        guard let data = response.data else {
            throw APIError.server("Heatmap paper data is empty.")
        }
        return data
    }

    func createHeatmapPaper(baseURL: String, token: String?, payload: [String: Any]) async throws {
        let body = try JSONSerialization.data(withJSONObject: payload)
        try await requestVoid(baseURL: baseURL, path: "/api/heatmap-paper", method: "POST", body: body, token: token)
    }

    func getAccountOverview(baseURL: String, token: String?) async throws -> AccountOverviewPayload {
        let response = try await request(baseURL: baseURL, path: "/api/account-overview", token: token, type: OverviewResponse.self)
        guard let data = response.data else {
            throw APIError.server("Account overview data is empty.")
        }
        return data
    }

    func getTokens(baseURL: String, token: String?) async throws -> [ApiToken] {
        let response = try await request(baseURL: baseURL, path: "/api/auth/tokens", token: token, type: TokensResponse.self)
        return response.data?.tokens ?? []
    }

    func getAuditLogs(baseURL: String, token: String?, take: Int = 30) async throws -> [AuditLog] {
        let response = try await request(baseURL: baseURL, path: "/api/audit?take=\(take)", token: token, type: AuditResponse.self)
        return response.data?.logs ?? []
    }

    func getSounds(baseURL: String, token: String?) async throws -> [String] {
        let response = try await request(baseURL: baseURL, path: "/api/sounds", token: token, type: SoundsResponse.self)
        return response.data?.files ?? []
    }

    func registerPushDevice(
        baseURL: String,
        token: String?,
        deviceToken: String,
        environment: String,
        appVersion: String?,
        deviceName: String?
    ) async throws {
        let payload: [String: Any?] = [
            "token": deviceToken,
            "platform": "ios",
            "environment": environment,
            "appVersion": appVersion,
            "deviceName": deviceName,
        ]
        let body = try JSONSerialization.data(withJSONObject: payload.compactMapValues { $0 })
        try await requestVoid(baseURL: baseURL, path: "/api/push/devices", method: "POST", body: body, token: token)
    }

    func unregisterPushDevice(baseURL: String, token: String?, deviceToken: String) async throws {
        let encoded = deviceToken.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? deviceToken
        try await requestVoid(baseURL: baseURL, path: "/api/push/devices?token=\(encoded)", method: "DELETE", token: token)
    }

    private func describeDecodingError(_ error: DecodingError) -> String {
        switch error {
        case .keyNotFound(let key, let context):
            let path = (context.codingPath + [key]).map(\.stringValue).joined(separator: ".")
            return "Missing key '\(key.stringValue)' at \(path)."
        case .valueNotFound(let type, let context):
            let path = context.codingPath.map(\.stringValue).joined(separator: ".")
            return "Missing value for \(type) at \(path)."
        case .typeMismatch(let type, let context):
            let path = context.codingPath.map(\.stringValue).joined(separator: ".")
            return "Type mismatch for \(type) at \(path)."
        case .dataCorrupted(let context):
            let path = context.codingPath.map(\.stringValue).joined(separator: ".")
            return "Data corrupted at \(path): \(context.debugDescription)"
        @unknown default:
            return error.localizedDescription
        }
    }
}
