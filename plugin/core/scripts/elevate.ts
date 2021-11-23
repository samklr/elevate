import * as _ from "lodash";
import { Helper } from "./helper";
import {
	ActivityInfoModel,
	AthleteModel,
	ReleaseNoteModel,
	SyncResultModel,
	UserSettingsModel
} from "@elevate/shared/models";
import { BrowserStorage } from "./browser-storage";
import { CoreEnv } from "../config/core-env";
import { AppResourcesModel } from "./models/app-resources.model";
import { AthleteUpdateModel } from "./models/athlete-update.model";
import { ActivitiesSyncModifier } from "./modifiers/activities-sync.modifier";
import { ActivityBestSplitsModifier } from "./modifiers/activity-best-splits.modifier";
import { ActivityBikeOdoModifier } from "./modifiers/activity-bike-odo.modifier";
import { ActivityQRCodeDisplayModifier } from "./modifiers/activity-qrcode-display.modifier";
import { ActivitySegmentTimeComparisonModifier } from "./modifiers/activity-segment-time-comparison.modifier";
import { ActivityStravaMapTypeModifier } from "./modifiers/activity-strava-map-type.modifier";
import { AthleteStatsModifier } from "./modifiers/athlete-stats.modifier";
import { DefaultLeaderBoardFilterModifier } from "./modifiers/default-leader-board-filter.modifier";
import { AbstractExtendedDataModifier } from "./modifiers/extended-stats/abstract-extended-data.modifier";
import { CyclingExtendedDataModifier } from "./modifiers/extended-stats/cycling-extended-data.modifier";
import { RunningExtendedDataModifier } from "./modifiers/extended-stats/running-extended-data.modifier";
import { GoogleMapsModifier } from "./modifiers/google-maps.modifier";
import { HideFeedModifier } from "./modifiers/hide-feed.modifier";
import { MenuModifier } from "./modifiers/menu.modifier";
import { NearbySegmentsModifier } from "./modifiers/nearby-segments.modifier";
import { RemoteLinksModifier } from "./modifiers/remote-links.modifier";
import {
	RunningCadenceModifier,
	RunningGradeAdjustedPaceModifier,
	RunningHeartRateModifier,
	RunningTemperatureModifier,
} from "./modifiers/running-data.modifier";
import { RunningAnalysisGraph } from "./modifiers/running-analysis-graph.modifier";
import { SegmentRankPercentageModifier } from "./modifiers/segment-rank-percentage.modifier";
import { SegmentRecentEffortsHRATimeModifier } from "./modifiers/segment-recent-efforts-hratime.modifier";
import { VirtualPartnerModifier } from "./modifiers/virtual-partner.modifier";
import { WindyTyModifier } from "./modifiers/windyty.modifier";
import { ActivityProcessor } from "./processors/activity-processor";
import { ISegmentInfo, SegmentProcessor } from "./processors/segment-processor";
import { VacuumProcessor } from "./processors/vacuum-processor";
import { ActivitiesSynchronize } from "./processors/activities-synchronize";
import * as Q from "q";
import { AthleteUpdate } from "./utils/athlete-update";
import "./follow";
import * as Cookies from "js-cookie";
import { ActivitiesChronologicalFeedModifier } from "./modifiers/activities-chronological-feed-modifier";
import { AthleteSnapshotResolver } from "@elevate/shared/resolvers";
import { releaseNotesData } from "@elevate/shared/data";
import { BrowserStorageType } from "./models/browser-storage-type.enum";
import { GenericExtendedDataModifier } from "./modifiers/extended-stats/generic-extended-data.modifier";

export class Elevate {

	public static instance: Elevate = null;

	public static LOCAL_VERSION_INSTALLED_KEY = "versionInstalled";
	public static LOCAL_ATHLETE_KEY = "athlete";

	public isPro: boolean;
	public isPremium: boolean;
	public athleteName: string;
	public activityAthleteId: number;
	public activityId: number;
	public athleteId: number;
	public athleteModelResolver: AthleteSnapshotResolver;
	public isOwner: boolean;
	public extensionId: string;
	public appResources: AppResourcesModel;
	public userSettings: UserSettingsModel;
	public vacuumProcessor: VacuumProcessor;
	public activitiesSynchronize: ActivitiesSynchronize;
	public pageMatches: { activity: boolean, dashboard: boolean, segment: boolean };

	constructor(userSettings: UserSettingsModel, appResources: AppResourcesModel) {

		this.userSettings = userSettings;
		this.appResources = appResources;

		if (Elevate.instance == null) {
			Elevate.instance = this;
		}
	}

	public run(): void {

		this.init().then(() => {

			// Redirect app.strava.com/* to www.strava.com/*
			if (this.handleForwardToWWW()) {
				return; // Skip rest of init to be compliant with www.strava.com/* on next reload
			}

			// Handle some tasks when install/update occurs
			this.handlePluginInstallOrUpgrade();

			if (CoreEnv.preview) {
				this.handlePreviewRibbon();
			}

			if (this.userSettings.localStorageMustBeCleared) {
				localStorage.clear();
				BrowserStorage.getInstance().upsertProperty<UserSettingsModel, boolean>(BrowserStorageType.LOCAL, ["userSettings", "localStorageMustBeCleared"], false);
			}

			// Init "elevate bridge"
			window.__elevate_bridge__ = {}; // TODO Find another solution

			// Common
			this.handleMenu();
			this.handleRemoteLinks();
			this.handleWindyTyModifier();
			this.handleDefaultLeaderboardFilter();
			this.handleSegmentRankPercentage();
			this.handleSegmentHRAP();
			this.handleActivityStravaMapType();
			this.handleActivitiesChronologicalFeedModifier();
			this.handleHideFeed();
			this.handleOnFlyActivitiesSync();
			this.handleActivitiesSyncFromOutside();

			// Bike
			this.handleExtendedActivityData();
			this.handleExtendedSegmentEffortData();
			this.handleNearbySegments();
			this.handleActivityBikeOdo();
			this.handleActivitySegmentTimeComparison();
			this.handleActivityBestSplits();

			// Run
			this.handleRunningGradeAdjustedPace();
			this.handleRunningHeartRate();
			this.handleRunningCadence();
			this.handleRunningTemperature();
			this.handleRunningAnalysisGraph();

			// All activities
			this.handleActivityQRCodeDisplay();
			this.handleVirtualPartner();
			this.handleAthletesStats();

			// Must be done at the end
			this.handleTrackTodayIncomingConnection();
			this.handleAthleteUpdate();
			this.saveAthleteId();
			this.handleGoogleMapsComeBackModifier();

			// Machine learning
			setTimeout(() => {
				this.handleActivityMachineLearningData();
			}, 1000);
		});
	}

	public init(): Promise<void> {

		this.extensionId = this.appResources.extensionId;

		if (!BrowserStorage.getInstance().hasExtensionId()) {
			BrowserStorage.getInstance().setExtensionId(this.extensionId);
		}

		return this.initAthleteModelResolver().then(() => {
			this.vacuumProcessor = new VacuumProcessor(this.athleteModelResolver);
			this.athleteId = this.vacuumProcessor.getAthleteId();
			this.athleteName = this.vacuumProcessor.getAthleteName();
			this.activityAthleteId = this.vacuumProcessor.getActivityAthleteId();
			this.isOwner = (this.activityAthleteId === this.athleteId || CoreEnv.forceIsActivityOwner);
			this.isPremium = this.vacuumProcessor.getPremiumStatus();
			this.isPro = this.vacuumProcessor.getProStatus();
			this.activityId = this.vacuumProcessor.getActivityId();
			this.activitiesSynchronize = new ActivitiesSynchronize(this.appResources, this.userSettings, this.athleteModelResolver);

			this.pageMatches = {
				activity: (window.location.pathname.match(/^\/activities/) !== null),
				dashboard: (window.location.pathname.match(/^\/dashboard/) !== null),
				segment: (window.location.pathname.match(/^\/segments\/(\d+)$/) !== null)
			};

			return Promise.resolve();

		});

	}

	public initAthleteModelResolver(): Promise<void> {

		if (this.athleteModelResolver) {
			return Promise.resolve();
		} else {
			return this.createAthleteModelResolver().then(athleteModelResolver => {
				this.athleteModelResolver = athleteModelResolver;
				return Promise.resolve();
			});
		}
	}

	public createAthleteModelResolver(): Promise<AthleteSnapshotResolver> {

		return new Promise((resolve, reject) => {
			BrowserStorage.getInstance().get<AthleteModel>(BrowserStorageType.LOCAL, Elevate.LOCAL_ATHLETE_KEY)
				.then((athleteModel: AthleteModel) => {
					resolve(new AthleteSnapshotResolver(athleteModel));
				}, error => reject(error));
		});
	}

	public handleForwardToWWW(): boolean {

		if (_.isEqual(window.location.hostname, "app.strava.com")) {
			const forwardUrl: string = window.location.protocol + "//www.strava.com" + window.location.pathname;
			window.location.href = forwardUrl;
			return true;
		}
		return false;
	}

	public showPluginInstallOrUpgradeRibbon(): void {

		const latestRelease: ReleaseNoteModel = _.first(releaseNotesData);

		if (_.isBoolean(latestRelease.silent) && latestRelease.silent) {
			console.log("Silent update... skip update ribbon");
			return;
		}

		const ribbonHtml: string = "<div id=\"pluginInstallOrUpgrade\" style=\"display: flex; justify-content: flex-start; position: fixed; z-index: 999; width: 100%; background-color: rgba(0, 0, 0, 0.8); color: white; font-size: 12px; padding-left: 10px; padding-top: 10px; padding-bottom: 10px;\">" +
			"<div style=\"margin-right: 10px; line-height: 20px; white-space: nowrap;\"><strong>Elevate updated" + ((latestRelease.isPatch) ? " <span style='color: aquamarine'>(Patch " + this.appResources.extVersion + ")</span>" : " to " + this.appResources.extVersion) + "</strong></div>" +
			"<div style=\"margin-right: 10px; line-height: 20px;\">" + latestRelease.message + "</div>" +
			"<div style=\"margin-right: 10px; white-space: nowrap; flex: 1; display: flex; justify-content: flex-end;\">" +
			"	<div>" +
			"		<div class=\"btn btn-primary btn-xs pluginInstallOrUpgrade_details\">View full release note</div>" +
			"		<div id=\"pluginInstallOrUpgrade_close\" class=\"btn btn-primary btn-xs\" style=\"margin-left: 10px;\">Close (<span id=\"pluginInstallOrUpgrade_counter\"></span>)</div>" +
			"	</div>" +
			"</div>" +
			"</div>";

		$("body").before(ribbonHtml).each(() => {

			const closeRibbon = function () {
				$("#pluginInstallOrUpgrade").slideUp(450, () => {
					$("#pluginInstallOrUpgrade").remove();
				});
				clearInterval(counterInterval);
			};

			// Display ribbon
			$("#pluginInstallOrUpgrade").hide();
			$("#pluginInstallOrUpgrade").slideDown(450);

			let counter = 30000;
			const refresh = 1000;
			$("#pluginInstallOrUpgrade_counter").html((("0" + (counter / 1000)).slice(-2)));
			const counterInterval = setInterval(() => {
				counter -= refresh;
				$("#pluginInstallOrUpgrade_counter").html((("0" + (counter / 1000)).slice(-2)));
			}, refresh);

			setTimeout(() => {
				closeRibbon();
			}, counter); // 10 sec auto hide

			$("#pluginInstallOrUpgrade_close").on("click", () => {
				closeRibbon();
			});

			$(".pluginInstallOrUpgrade_details").on("click", () => {
				window.open(this.appResources.settingsLink + "#/releasesNotes", "_blank");
			});
		});
	}

	public handlePluginInstallOrUpgrade(): void {

		if (!this.pageMatches.dashboard) {
			return;
		}

		if (window.location.search.match("elevateSync")) {
			console.log("Skip handlePluginInstallOrUpgrade since we are on a sync");
			return;
		}

		const saveCurrentVersionInstalled = (callback: Function) => {

			const toBeStored = {
				version: this.appResources.extVersion,
				on: Date.now(),
			};

			BrowserStorage.getInstance().set<object>(BrowserStorageType.LOCAL, Elevate.LOCAL_VERSION_INSTALLED_KEY, toBeStored).then(() => {
				console.log("Version has been saved to local storage");
				callback();
			});
		};

		// Check for previous version is installed
		BrowserStorage.getInstance().get<object>(BrowserStorageType.LOCAL, Elevate.LOCAL_VERSION_INSTALLED_KEY).then((response: any) => {

			// Override version with fake one to simulate update
			if (CoreEnv.simulateUpdate) {
				response = {
					data: {
						version: "fakeVersion",
						on: 0,
					},
				};
			}

			if (!response || !response.version) {

				// No previous version installed. It's an install of the plugin
				console.log("No previous version found. Should be an fresh install of " + this.appResources.extVersion);

				// Display ribbon update message
				this.showPluginInstallOrUpgradeRibbon();

				// Save current version to chrome local storage
				saveCurrentVersionInstalled(() => {
				});

			} else {

				// A version is already installed. It's an update
				if (response.version && response.version !== this.appResources.extVersion) {

					// Version has changed...
					console.log("Previous install found <" + response.version + "> installed on " + new Date(response.on));
					console.log("Moving to version <" + this.appResources.extVersion + ">");

					// Clear HTML5 local storage
					console.log("Plugin upgraded, clear browser local storage");
					localStorage.clear();

					// Display ribbon update message
					this.showPluginInstallOrUpgradeRibbon();

					// Save current version to chrome local storage
					saveCurrentVersionInstalled(() => {
					});

					// Send updated version info to
					const updatedToEvent: any = {
						categorie: "Exploitation",
						action: "updatedVersion",
						name: this.appResources.extVersion,
					};

					follow("send", "event", updatedToEvent.categorie, updatedToEvent.action, updatedToEvent.name);

					Cookies.remove("elevate_athlete_update_done"); // Remove elevate_athlete_update_done cookie to trigger athlete commit earlier

				} else {
					console.log("No install or update detected");
				}

			}
		});
	}

	public handleAthletesStats(): void {

		// If we are not on the athletes page then return...
		if (!window.location.pathname.match(new RegExp("/athletes/" + this.athleteId + "$", "g"))) {
			return;
		}

		const athleteStatsModifier: AthleteStatsModifier = new AthleteStatsModifier(this.appResources);
		athleteStatsModifier.modify();
	}

	public handlePreviewRibbon(): void {
		const globalStyle = "background-color: #FFF200; color: rgb(84, 84, 84); font-size: 12px; padding: 5px; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; text-align: center;";
		const html: string = "<div id=\"updateRibbon\" style=\"" + globalStyle + "\"><strong>WARNING</strong> You are running a preview of <strong>Elevate</strong>, to remove it, open a new tab and type <strong>chrome://extensions</strong></div>";
		$("body").before(html);
	}

	public handleMenu(): void {

		const menuModifier: MenuModifier = new MenuModifier(this.athleteId, this.appResources);
		menuModifier.modify();
	}

	public handleRemoteLinks(): void {

		if (!this.userSettings.remoteLinks) {
			return;
		}

		// If we are not on a segment or activity page then return...
		if (!this.pageMatches.segment && !this.pageMatches.activity) {
			return;
		}

		const remoteLinksModifier: RemoteLinksModifier = new RemoteLinksModifier(this.appResources, (this.activityAthleteId === this.athleteId), this.activityId);
		remoteLinksModifier.modify();
	}

	public handleWindyTyModifier(): void {

		if (!this.userSettings.displayWindyOverlay) {
			return;
		}

		// If we are not on a segment or activity page then return...
		if (!this.pageMatches.activity) {
			return;
		}

		if (!window.pageView) {
			return;
		}

		// Avoid running Extended data at the moment
		if (window.pageView.activity().get("type") !== "Ride") {
			return;
		}

		// If home trainer skip (it will use gps data to locate weather data)
		if (window.pageView.activity().get("trainer")) {
			return;
		}

		const windyTyModifier: WindyTyModifier = new WindyTyModifier(this.activityId, this.appResources, this.userSettings);
		windyTyModifier.modify();
	}

	public handleDefaultLeaderboardFilter(): void {

		// If we are not on a segment or activity page then return...
		if (!this.pageMatches.activity) {
			return;
		}

		// Kick out if we are not on SegmentLeaderboardView
		const view: any = Strava.Labs.Activities.SegmentLeaderboardView;

		if (!view) {
			return;
		}

		const defaultLeaderBoardFilterModifier: DefaultLeaderBoardFilterModifier = new DefaultLeaderBoardFilterModifier(this.userSettings.defaultLeaderBoardFilter);
		defaultLeaderBoardFilterModifier.modify();
	}

	public handleSegmentRankPercentage(): void {

		if (!this.userSettings.displaySegmentRankPercentage) {
			return;
		}

		// If we are not on a segment page then return...
		if (!this.pageMatches.segment) {
			return;
		}

		const segmentRankPercentage: SegmentRankPercentageModifier = new SegmentRankPercentageModifier();
		segmentRankPercentage.modify();
	}

	public handleSegmentHRAP() {

		if (!this.userSettings.showHiddenBetaFeatures || !this.userSettings.displayRecentEffortsHRAdjustedPacePower) {
			return;
		}

		// If we are not on a segment page then return...
		if (!this.pageMatches.segment) {
			return;
		}

		const athleteSnapshot = this.athleteModelResolver.getCurrent(); // TODO Could be improved by using AthleteModel at each dates

		const segmentId: number = parseInt(/^\/segments\/(\d+)$/.exec(window.location.pathname)[1]);
		const segmentHRATime: SegmentRecentEffortsHRATimeModifier = new SegmentRecentEffortsHRATimeModifier(this.userSettings.displayRecentEffortsHRAdjustedPacePower,
			athleteSnapshot,
			this.athleteId,
			segmentId);
		segmentHRATime.modify();

	}

	public handleActivityStravaMapType(): void {

		// Test where are on an activity...
		if (!this.pageMatches.activity) {
			return;
		}

		const activityStravaMapTypeModifier: ActivityStravaMapTypeModifier = new ActivityStravaMapTypeModifier(this.userSettings.activityStravaMapType);
		activityStravaMapTypeModifier.modify();
	}

	public handleHideFeed(): void {

		// Test if where are on dashboard page
		if (!this.pageMatches.dashboard) {
			return;
		}

		if (!this.userSettings.feedHideChallenges
			&& !this.userSettings.feedHideCreatedRoutes
			&& !this.userSettings.feedHidePosts
			&& !this.userSettings.feedHideRideActivitiesUnderDistance
			&& !this.userSettings.feedHideRunActivitiesUnderDistance
			&& !this.userSettings.feedHideVirtualRides
			&& !this.userSettings.feedHideSuggestedAthletes) {
			return;
		}

		const hideFeedModifier: HideFeedModifier = new HideFeedModifier(this.userSettings);
		hideFeedModifier.modify();
	}

	public handleActivitiesChronologicalFeedModifier(): void {
		if (!this.pageMatches.dashboard) {
			return;
		}

		if (!this.userSettings.feedChronologicalOrder) {
			return;
		}

		const activityFeedModifier: ActivitiesChronologicalFeedModifier = new ActivitiesChronologicalFeedModifier(this.userSettings);
		activityFeedModifier.modify();
	}

	public handleExtendedActivityData(): void {

		if (_.isUndefined(window.pageView)) {
			return;
		}

		const activityInfo: ActivityInfoModel = {
			id: this.activityId,
			type: window.pageView.activity().get("type"),
			name: this.vacuumProcessor.getActivityName(),
			startTime: this.vacuumProcessor.getActivityStartDate(),
			supportsGap: window.pageView.activity().get("supportsGap"),
			isTrainer: window.pageView.activity().get("trainer"),
			isOwner: this.isOwner
		};

		// Skip manual activities
		if (activityInfo.type === "Manual") {
			return;
		}

		const activityProcessor = new ActivityProcessor(this.vacuumProcessor, this.athleteModelResolver, this.appResources, this.userSettings, activityInfo);

		let extendedDataModifier: AbstractExtendedDataModifier;

		switch (activityInfo.type) {
			case "Ride":
				extendedDataModifier = new CyclingExtendedDataModifier(
					activityProcessor,
					activityInfo,
					this.appResources,
					this.userSettings,
					AbstractExtendedDataModifier.TYPE_ACTIVITY);
				extendedDataModifier.apply();
				break;
			case "Run":
				extendedDataModifier = new RunningExtendedDataModifier(
					activityProcessor,
					activityInfo,
					this.appResources,
					this.userSettings,
					AbstractExtendedDataModifier.TYPE_ACTIVITY);
				extendedDataModifier.apply();
				break;
			default:
				extendedDataModifier = new GenericExtendedDataModifier(activityProcessor, activityInfo, this.appResources,
					this.userSettings, AbstractExtendedDataModifier.TYPE_ACTIVITY);
				extendedDataModifier.apply();
				break;
		}

		// Send opened activity type to ga for stats
		const updatedToEvent: any = {
			categorie: "Analyse",
			action: "openedActivityType",
			name: activityInfo.type,
		};

		follow("send", "event", updatedToEvent.categorie, updatedToEvent.action, updatedToEvent.name);

	}

	public handleExtendedSegmentEffortData(): void {

		if (_.isUndefined(window.pageView)) {
			return;
		}

		if (!Strava.Labs) {
			return;
		}

		const activityInfo: ActivityInfoModel = {
			id: this.activityId,
			type: window.pageView.activity().get("type"),
			name: this.vacuumProcessor.getActivityName(),
			startTime: this.vacuumProcessor.getActivityStartDate(),
			supportsGap: window.pageView.activity().get("supportsGap"),
			isTrainer: window.pageView.activity().get("trainer"),
			isOwner: this.isOwner
		};

		// Skip manual activities
		if (activityInfo.type === "Manual") {
			return;
		}

		const activityProcessor = new ActivityProcessor(this.vacuumProcessor, this.athleteModelResolver, this.appResources, this.userSettings, activityInfo);

		let view: any;

		if (_.indexOf(["Run", "Hike", "Walk"], activityInfo.type) !== -1) {
			view = Strava.Labs.Activities.SegmentEffortDetailView;
		} else {
			view = Strava.Labs.Activities.SegmentLeaderboardView;
		}

		if (view) {

			const functionRender: any = view.prototype.render;

			const that: Elevate = this;

			view.prototype.render = function () { // No arrow function here with! If yes loosing arguments

				const r: any = functionRender.apply(this, Array.prototype.slice.call(arguments));

				let extendedDataModifier: AbstractExtendedDataModifier;

				switch (activityInfo.type) {
					case "Ride":
						extendedDataModifier = new CyclingExtendedDataModifier(
							activityProcessor,
							activityInfo,
							that.appResources,
							that.userSettings,
							AbstractExtendedDataModifier.TYPE_SEGMENT);
						extendedDataModifier.apply();
						break;
					case "Run":
						extendedDataModifier = new RunningExtendedDataModifier(
							activityProcessor,
							activityInfo,
							that.appResources,
							that.userSettings,
							AbstractExtendedDataModifier.TYPE_SEGMENT);
						extendedDataModifier.apply();
						break;

					default:
						extendedDataModifier = new GenericExtendedDataModifier(activityProcessor, activityInfo, that.appResources,
							that.userSettings, AbstractExtendedDataModifier.TYPE_SEGMENT);
						extendedDataModifier.apply();
						break;
				}
				return r;
			};

		}
	}

	public handleNearbySegments(): void {

		if (!this.userSettings.displayNearbySegments) {
			return;
		}

		// If we are not on a segment page then return...
		const segmentData: string[] = window.location.pathname.match(/^\/segments\/(\d+)$/);
		if (_.isNull(segmentData)) {
			return;
		}

		// Getting segment id
		const segmentId: number = parseInt(segmentData[1]);

		const segmentProcessor: SegmentProcessor = new SegmentProcessor(this.vacuumProcessor, segmentId);
		segmentProcessor.getNearbySegmentsAround((jsonSegments: ISegmentInfo[]) => {

			const nearbySegmentsModifier: NearbySegmentsModifier = new NearbySegmentsModifier(jsonSegments, this.appResources);
			nearbySegmentsModifier.modify();

		});
	}

	public handleActivityBikeOdo(): void {

		if (!this.userSettings.displayBikeOdoInActivity) {
			return;
		}

		// Test where are on an activity...
		if (!this.pageMatches.activity) {
			return;
		}

		if (_.isUndefined(window.pageView)) {
			return;
		}

		// Avoid running Extended data at the moment
		if (window.pageView.activity().attributes.type != "Ride") {
			return;
		}

		const activityBikeOdoModifier: ActivityBikeOdoModifier = new ActivityBikeOdoModifier(this.vacuumProcessor, this.athleteId);
		activityBikeOdoModifier.modify();
	}

	public handleActivitySegmentTimeComparison(): void {

		// Test where are on an activity page... (note this includes activities/XXX/segments)
		if (!this.pageMatches.activity) {
			return;
		}

		if (_.isUndefined(window.pageView)) {
			return;
		}

		const activityType: string = window.pageView.activity().get("type");

		// PR only for my own activities
		const activitySegmentTimeComparisonModifier: ActivitySegmentTimeComparisonModifier = new ActivitySegmentTimeComparisonModifier(this.userSettings, this.appResources, activityType, this.isOwner);
		activitySegmentTimeComparisonModifier.modify();

	}

	public handleActivityBestSplits(): void {

		if (!this.userSettings.displayActivityBestSplits) {
			return;
		}

		// Test where are on an activity...
		if (!this.pageMatches.activity) {
			return;
		}

		if (_.isUndefined(window.pageView)) {
			return;
		}

		// Only cycling is supported
		const activityType: string = window.pageView.activity().attributes.type;
		if (activityType != "Ride") {
			return;
		}

		const activityInfo: ActivityInfoModel = {
			id: this.activityId,
			type: window.pageView.activity().get("type"),
			name: this.vacuumProcessor.getActivityName(),
			startTime: this.vacuumProcessor.getActivityStartDate(),
			supportsGap: window.pageView.activity().get("supportsGap"),
			isTrainer: window.pageView.activity().get("trainer"),
			isOwner: this.isOwner
		};

		BrowserStorage.getInstance().get(BrowserStorageType.LOCAL, "bestSplitsConfiguration").then((response: any) => {
			const activityBestSplitsModifier: ActivityBestSplitsModifier = new ActivityBestSplitsModifier(this.vacuumProcessor, activityInfo, this.userSettings, response, (splitsConfiguration: any) => {
				BrowserStorage.getInstance().set(BrowserStorageType.LOCAL, "bestSplitsConfiguration", splitsConfiguration);
			});
			activityBestSplitsModifier.modify();
		});
	}

	public handleRunningGradeAdjustedPace(): void {

		if (!this.userSettings.activateRunningGradeAdjustedPace) {
			return;
		}

		if (_.isUndefined(window.pageView)) {
			return;
		}

		// Avoid bike activity
		if (window.pageView.activity().attributes.type != "Run") {
			return;
		}

		if (!this.pageMatches.activity) {
			return;
		}

		const runningGradeAdjustedPace: RunningGradeAdjustedPaceModifier = new RunningGradeAdjustedPaceModifier();
		runningGradeAdjustedPace.modify();
	}

	public handleRunningHeartRate(): void {

		if (!this.userSettings.activateRunningHeartRate) {
			return;
		}

		if (_.isUndefined(window.pageView)) {
			return;
		}

		// Avoid bike activity
		if (window.pageView.activity().attributes.type != "Run") {
			return;
		}

		if (!this.pageMatches.activity) {
			return;
		}

		const runningHeartRateModifier: RunningHeartRateModifier = new RunningHeartRateModifier();
		runningHeartRateModifier.modify();
	}

	public handleRunningCadence(): void {

		if (!this.userSettings.activateRunningCadence) {
			return;
		}

		if (_.isUndefined(window.pageView)) {
			return;
		}

		// Avoid bike activity
		if (window.pageView.activity().attributes.type != "Run") {
			return;
		}

		if (!this.pageMatches.activity) {
			return;
		}

		const runningCadenceModifier: RunningCadenceModifier = new RunningCadenceModifier();
		runningCadenceModifier.modify();
	}

	public handleRunningTemperature(): void {

		if (!this.userSettings.activateRunningTemperature) {
			return;
		}

		if (_.isUndefined(window.pageView)) {
			return;
		}

		// Avoid bike activity
		if (window.pageView.activity().attributes.type != "Run") {
			return;
		}

		if (!this.pageMatches.activity) {
			return;
		}

		const runningTemperatureModifier: RunningTemperatureModifier = new RunningTemperatureModifier();
		runningTemperatureModifier.modify();
	}

	protected handleRunningAnalysisGraph(): void {

		if (_.isUndefined(window.pageView)) {
			return;
		}

		// Avoid bike activity
		if (window.pageView.activity().attributes.type != "Run") {
			return;
		}

		if (!this.pageMatches.activity) {
			return;
		}

		const runningAnalysisGraph: RunningAnalysisGraph = new RunningAnalysisGraph();
		runningAnalysisGraph.modify();
	}


	public handleActivityQRCodeDisplay(): void {

		// Test where are on an activity...
		if (!this.pageMatches.activity) {
			return;
		}

		if (_.isUndefined(window.pageView)) {
			return;
		}

		const activityQRCodeDisplayModifier: ActivityQRCodeDisplayModifier = new ActivityQRCodeDisplayModifier(this.appResources, this.activityId);
		activityQRCodeDisplayModifier.modify();

	}

	public handleVirtualPartner(): void {

		// Test where are on an activity...
		if (!this.pageMatches.activity) {
			return;
		}

		const type = window.pageView.activity().get("type");
		if (type !== "Ride" && type !== "VirtualRide") {
			return;
		}
		const virtualPartnerModifier: VirtualPartnerModifier = new VirtualPartnerModifier(this.activityId, this.vacuumProcessor);
		virtualPartnerModifier.modify();
	}

	public handleGoogleMapsComeBackModifier(): void {

		if (window.location.pathname.match(/\/truncate/)) { // Skipping on activity cropping
			return;
		}

		if (!this.userSettings.reviveGoogleMaps) {
			return;
		}

		// Test where are on an activity...
		if (!this.pageMatches.activity) {
			return;
		}

		const googleMapsModifier: GoogleMapsModifier = new GoogleMapsModifier(this.activityId, this.appResources, this.userSettings);
		googleMapsModifier.modify();
	}

	/**
	 * Launch a track event once a day (is user use it once a day), to follow is account type
	 */
	public handleTrackTodayIncomingConnection(): void {

		const userHasConnectSince24Hour: boolean = (Cookies.get("elevate_daily_connection_done") === "true");

		if (_.isNull(this.athleteId)) {
			return;
		}

		if (!userHasConnectSince24Hour) {

			let accountType = "Free";
			const accountName: string = this.athleteName;

			// We enter in that condition if user is premium or pro
			if (!_.isNull(this.isPremium) && this.isPremium === true) {
				accountType = "Premium";
			}

			// accountType is overridden with "pro" if that condition is true
			if (!_.isNull(this.isPro) && this.isPro === true) {
				accountType = "Pro";
			}

			const eventAction: string = "DailyConnection_Account_" + accountType;

			// Push IncomingConnection
			const eventName: string = accountName + " #" + this.athleteId + " v" + this.appResources.extVersion;

			if (!CoreEnv.debugMode) {
				follow("send", "event", "DailyConnection", eventAction, eventName);
			}

			// Create cookie to avoid push during 1 day
			Cookies.set("elevate_daily_connection_done", "true", {expires: 1});

		} else {
		}
	}

	public handleAthleteUpdate(): void {
		if (!Cookies.get("elevate_athlete_update_done")) {
			this.commitAthleteUpdate().then((response: any) => {
				console.log("Updated", response);
				Cookies.set("elevate_athlete_update_done", "true", {expires: (1 / 4)}); // Don't update for 6 hours
			}, (err: any) => {
				console.error(err);
			});
		}
	}

	public saveAthleteId(): void {
		BrowserStorage.getInstance().set<number>(BrowserStorageType.LOCAL, "athleteId", this.athleteId).then(() => {
			console.debug("athlete id set to " + this.athleteId);
		}, error => console.error(error));
	}

	public handleOnFlyActivitiesSync(): void {

		// Skipping on fly sync because a dedicated sync has been asked by user
		if (window.location.search.match("elevateSync")) {
			console.log("Sync Popup. Skip handleOnFlyActivitiesSync()");
			return;
		}

		if (window.location.pathname.match("login") || window.location.pathname.match("upload")) {
			console.log("Login or upload page. Skip handleOnFlyActivitiesSync()");
			return;
		}

		const waitBeforeFastSyncSeconds = 3;
		setTimeout(() => {

			// Allow activities sync if previous sync exists and has been done 12 hours or more ago.
			BrowserStorage.getInstance().get<number>(BrowserStorageType.LOCAL, ActivitiesSynchronize.LAST_SYNC_DATE_TIME_KEY).then((lastSyncDateTime: number) => {

				if (_.isNumber(lastSyncDateTime)) {

					console.log("A previous sync exists on " + new Date(lastSyncDateTime).toString());

					// At first perform a fast sync to get the "just uploaded ride/run" ready
					const fastSync = true;
					const fastSyncPromise: Q.Promise<SyncResultModel> = this.activitiesSynchronize.sync(fastSync);
					fastSyncPromise.then((syncResult: SyncResultModel) => {

						console.log("Fast sync finished", syncResult);
						ActivitiesSynchronize.notifyBackgroundSyncDone.call(this, this.extensionId, syncResult); // Notify background page that sync is finished

					}).catch((err: any) => {
						console.warn(err);
					});

				} else {
					console.log("No previous sync found. A first sync must be performed");
				}
			});

		}, 1000 * waitBeforeFastSyncSeconds); // Wait for before starting the auto-sync

	}

	public handleActivitiesSyncFromOutside() {

		if (!window.location.search.match("elevateSync")) { // Skipping is we are not on sync popup
			return;
		}

		const urlParams = Helper.params(window.location);

		const syncingAllowed = (urlParams.elevateSync === "true");
		if (!syncingAllowed) {
			return;
		}

		const forceSync = (urlParams.forceSync === "true");
		const fastSync = (urlParams.fastSync === "true" && !forceSync);
		const sourceTabId = (urlParams.sourceTabId) ? parseInt(urlParams.sourceTabId) : -1;

		const activitiesSyncModifier: ActivitiesSyncModifier = new ActivitiesSyncModifier(this.extensionId, this.activitiesSynchronize, fastSync, forceSync, sourceTabId);
		activitiesSyncModifier.modify();
	}

	public commitAthleteUpdate(): Q.IPromise<any> {

		const athleteModel = this.athleteModelResolver.getCurrent();

		const athleteUpdate: AthleteUpdateModel = AthleteUpdate.create(this.athleteId, this.athleteName,
			(this.appResources.extVersion !== "0") ? this.appResources.extVersion : this.appResources.extVersionName,
			this.isPremium, this.isPro, window.navigator.language, athleteModel.athleteSettings.restHr, athleteModel.athleteSettings.maxHr);
		return AthleteUpdate.commit(athleteUpdate);
	}

	private handleActivityMachineLearningData() {

		function geoBaryCenter(latLngStream: number[][]) {
			if (!latLngStream || !Array.isArray(latLngStream) || latLngStream.length === 0) {
				return null;
			}

			const lat = latLngStream.map(latLng => latLng[0]);
			const lng = latLngStream.map(latLng => latLng[1]);
			const cLat = (Math.min(...lat) + Math.max(...lat)) / 2;
			const cLng = (Math.min(...lng) + Math.max(...lng)) / 2;
			return [cLat, cLng];
		}

		if (_.isUndefined(window.pageView)) {
			return;
		}

		const activity = window.pageView.activity();

		if (!activity.get("id") || !activity.get("type")) {
			return;
		}

		if (activity.get("type") === "Manual") {
			return;
		}

		const elapsedTime: number = window.pageView.streamsRequest && window.pageView.streamsRequest.streams
		&& window.pageView.streamsRequest.streams.attributes
		&& window.pageView.streamsRequest.streams.attributes.time
			? _.last(window.pageView.streamsRequest.streams.attributes.time) || null : null;
		const movingTime = activity.get("moving_time") || null;
		const distance = activity.get("distance") || null;

		const avgSpeed = (distance && movingTime) ? _.round(distance / movingTime, 3) : null;

		const activityML: any = {};
		activityML.id = activity.get("id") || null;
		activityML.athleteId = window.pageView.activityAthlete && window.pageView.activityAthlete()
			&& window.pageView.activityAthlete().id || null;
		activityML.type = activity.get("detailedType") || null;
		activityML.movingTime = movingTime;
		activityML.distance = _.round(distance);
		activityML.elevation = activity.get("elev_gain") || null;
		activityML.avgSpeed = avgSpeed;
		activityML.avgHr = _.round(activity.get("avg_hr")) || null;
		activityML.avgCad = _.round(activity.get("avg_cadence")) || null;
		activityML.avgWatts = _.round(activity.get("avgWatts")) || null;
		activityML.trainer = !!activity.get("trainer");

		if (window.pageView.streamsRequest && window.pageView.streamsRequest.streams && window.pageView.streamsRequest.streams.attributes) {

			const streams = window.pageView.streamsRequest.streams.attributes;

			if (!activityML.distance && streams.distance) {
				activityML.distance = _.last(streams.distance) || null;
			}

			if (!activityML.avgSpeed && streams.time && streams.distance && streams.time.length > 0 && streams.distance.length > 0) {

				const speeds = [];
				streams.time.forEach((time, index) => {
					if (index === 0) {
						return;
					}
					const deltaTime = time - streams.time[index - 1];
					const deltaDist = streams.distance[index] - streams.distance[index - 1];
					const speed = deltaDist / deltaTime;
					if (Number.isFinite(speed)) {
						speeds.push(speed);
					}

				});

				activityML.avgSpeed = _.round(_.mean(speeds), 3);
			}

			if (!activityML.movingTime && streams.time && streams.distance && streams.time.length > 0 && streams.distance.length > 0) {

				const times = [];
				streams.time.forEach((time, index) => {
					if (index === 0) {
						return;
					}
					const deltaTime = time - streams.time[index - 1];
					const deltaDist = streams.distance[index] - streams.distance[index - 1];
					const speed = deltaDist / deltaTime;
					if (Number.isFinite(speed) && speed > 0) {
						times.push(deltaTime);
					}
				});

				let moveTime: number = _.round(_.sum(times));
				if (elapsedTime && moveTime && moveTime > elapsedTime) {
					moveTime = elapsedTime;
				}

				activityML.movingTime = moveTime;
			}

			if (!activityML.elevation && streams.altitude && streams.altitude.length > 0) {

				let elevationGain = 0;

				streams.altitude.forEach((elevation, index) => {
					if (index === 0) {
						return;
					}
					const deltaElevation = elevation - streams.altitude[index - 1];

					if (deltaElevation > 0) {
						elevationGain += deltaElevation;
					}

				});

				activityML.elevation = Math.round(elevationGain);
			}

			if (!activityML.avgHr) {
				activityML.avgHr = (streams.heartrate && streams.heartrate.length > 0) ? _.round(_.mean(streams.heartrate)) : null;
			}

			if (!activityML.avgCad) {
				activityML.avgCad = (streams.cadence && streams.cadence.length > 0) ? _.round(_.mean(streams.cadence)) : null;
			}

			activityML.baryCenter = (streams.latlng && streams.latlng.length > 0) ? geoBaryCenter(streams.latlng) : null;
		}

		const endPoint = `https://peak-dev-elevate.koyeb.app/ml-data/activities`;

		const options = {
			method: "POST",
			body: JSON.stringify(activityML),
			headers: {
				"Content-Type": "application/json"
			}
		};

		fetch(endPoint, options).then(response => {
			if (response.status !== 201) {
				options.method = "PUT";
				fetch(`${endPoint}/${activityML.id}`, options);
			}
		});
	}
}
