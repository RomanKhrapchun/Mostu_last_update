const communitySettingsRepository = require('../repository/communitySettings-repository');
const redisClient = require('../../../helpers/redis');
const Logger = require('../../../utils/logger');

const CACHE_KEY = 'community_settings';
const CACHE_TTL = 3600; // 1 hour in seconds

class CommunitySettingsService {

    async getSettings() {
        try {
            // Try to get from cache first
            const cached = await redisClient.get(CACHE_KEY);
            if (cached) {
                Logger.info('Community settings loaded from cache');
                return JSON.parse(cached);
            }

            // If not in cache, get from database
            const settings = await communitySettingsRepository.getSettings();

            if (settings) {
                // Store in cache
                await redisClient.setex(CACHE_KEY, CACHE_TTL, JSON.stringify(settings));
                Logger.info('Community settings loaded from DB and cached');
            }

            return settings;
        } catch (error) {
            Logger.error('Error getting community settings:', error);
            // If cache fails, try to get directly from DB
            return await communitySettingsRepository.getSettings();
        }
    }

    async updateSettings(settings) {
        try {
            const updated = await communitySettingsRepository.updateSettings(settings);

            if (updated) {
                // Invalidate cache
                await this.invalidateCache();
                Logger.info('Community settings updated and cache invalidated');
            }

            return updated;
        } catch (error) {
            Logger.error('Error updating community settings:', error);
            throw error;
        }
    }

    async createSettings(settings) {
        try {
            const created = await communitySettingsRepository.createSettings(settings);

            if (created) {
                // Invalidate cache
                await this.invalidateCache();
                Logger.info('Community settings created and cache invalidated');
            }

            return created;
        } catch (error) {
            Logger.error('Error creating community settings:', error);
            throw error;
        }
    }

    async invalidateCache() {
        try {
            await redisClient.del(CACHE_KEY);
            Logger.info('Community settings cache invalidated');
        } catch (error) {
            Logger.error('Error invalidating cache:', error);
        }
    }

    // Transform DB fields to frontend format (camelCase)
    transformToFrontend(settings) {
        if (!settings) return null;

        return {
            id: settings.id,
            cityName: settings.city_name,
            cityCouncil: settings.city_council,
            altCityName: settings.alt_city_name,
            territoryTitle: settings.territory_title,
            territoryTitleInstrumental: settings.territory_title_instrumental,
            websiteName: settings.website_name,
            websiteUrl: settings.website_url,
            websiteUrlP4v: settings.website_url_p4v,
            telegramName: settings.telegram_name,
            telegramUrl: settings.telegram_url,
            phoneNumberGuDps: settings.phone_number_gu_dps,
            phoneNumberKindergarten: settings.phone_number_kindergarten,
            currentRegion: settings.current_region,
            guDpsRegion: settings.gu_dps_region,
            guDpsAddress: settings.gu_dps_address,
            debtChargeAccount: settings.debt_charge_account,
            communityName: settings.community_name,
            altQrCode: settings.alt_qr_code,
            createdAt: settings.created_at,
            updatedAt: settings.updated_at
        };
    }

    // Transform frontend format (camelCase) to DB fields (snake_case)
    transformToDb(settings) {
        if (!settings) return null;

        return {
            id: settings.id,
            city_name: settings.cityName,
            city_council: settings.cityCouncil,
            alt_city_name: settings.altCityName,
            territory_title: settings.territoryTitle,
            territory_title_instrumental: settings.territoryTitleInstrumental,
            website_name: settings.websiteName,
            website_url: settings.websiteUrl,
            website_url_p4v: settings.websiteUrlP4v,
            telegram_name: settings.telegramName,
            telegram_url: settings.telegramUrl,
            phone_number_gu_dps: settings.phoneNumberGuDps,
            phone_number_kindergarten: settings.phoneNumberKindergarten,
            current_region: settings.currentRegion,
            gu_dps_region: settings.guDpsRegion,
            gu_dps_address: settings.guDpsAddress,
            debt_charge_account: settings.debtChargeAccount,
            community_name: settings.communityName,
            alt_qr_code: settings.altQrCode
        };
    }
}

module.exports = new CommunitySettingsService();
