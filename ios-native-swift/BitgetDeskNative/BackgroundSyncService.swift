import BackgroundTasks
import Foundation
import UIKit

struct BackgroundSyncStatus {
    let lastSuccessAt: Date?
    let lastError: String?
}

enum BackgroundRefreshOutcome {
    case newData
    case noData
    case failed(String)

    var taskSuccess: Bool {
        switch self {
        case .failed:
            return false
        case .newData, .noData:
            return true
        }
    }

    var fetchResult: UIBackgroundFetchResult {
        switch self {
        case .newData:
            return .newData
        case .noData:
            return .noData
        case .failed:
            return .failed
        }
    }
}

final class BackgroundSyncService {
    static let shared = BackgroundSyncService()

    private let api = APIClient.shared
    private let userDefaults = UserDefaults.standard
    private let baseURLKey = "native.baseURL"
    private let lastSuccessAtKey = "native.background.lastSuccessAt"
    private let lastErrorKey = "native.background.lastError"

    static var taskIdentifier: String {
        "\(Bundle.main.bundleIdentifier ?? "com.bitgetdesk.nativeclone").apprefresh"
    }

    private init() {}

    func registerBackgroundTasks() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.taskIdentifier, using: nil) { task in
            guard let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }

            self.handleAppRefresh(task: refreshTask)
        }
    }

    func scheduleAppRefresh(after seconds: TimeInterval = 15 * 60) {
        let request = BGAppRefreshTaskRequest(identifier: Self.taskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: max(60, seconds))

        do {
            try BGTaskScheduler.shared.submit(request)
            clearError()
        } catch {
            saveError("Unable to schedule iOS background refresh: \(error.localizedDescription)")
        }
    }

    func cancelPendingRefresh() {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.taskIdentifier)
    }

    func currentStatus() -> BackgroundSyncStatus {
        let timestamp = userDefaults.double(forKey: lastSuccessAtKey)
        let lastSuccessAt = timestamp > 0 ? Date(timeIntervalSince1970: timestamp) : nil
        let lastError = userDefaults.string(forKey: lastErrorKey)
        return BackgroundSyncStatus(lastSuccessAt: lastSuccessAt, lastError: lastError)
    }

    func performBackgroundRefresh() async -> BackgroundRefreshOutcome {
        let baseURL = (userDefaults.string(forKey: baseURLKey) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if baseURL.isEmpty {
            return .noData
        }

        let token = KeychainStore.loadToken()

        do {
            let settings = try await api.getSettings(baseURL: baseURL, token: token)
            let mode = settings.trading_mode

            try await api.runMonitor(baseURL: baseURL, token: token, mode: mode)
            if let positions = try? await api.getPositions(baseURL: baseURL, token: token, mode: mode) {
                await TradeNotificationCoordinator.shared.processPositionsSnapshot(mode: positions.mode ?? mode, payload: positions)
            }

            saveSuccess()
            return .newData
        } catch {
            let message = error.localizedDescription
            saveError(message)
            return .failed(message)
        }
    }

    private func handleAppRefresh(task: BGAppRefreshTask) {
        scheduleAppRefresh()

        let worker = Task {
            let outcome = await performBackgroundRefresh()
            if !Task.isCancelled {
                task.setTaskCompleted(success: outcome.taskSuccess)
            }
        }

        task.expirationHandler = {
            worker.cancel()
        }
    }

    private func saveSuccess() {
        userDefaults.set(Date().timeIntervalSince1970, forKey: lastSuccessAtKey)
        clearError()
    }

    private func saveError(_ message: String) {
        userDefaults.set(message, forKey: lastErrorKey)
    }

    private func clearError() {
        userDefaults.removeObject(forKey: lastErrorKey)
    }
}
