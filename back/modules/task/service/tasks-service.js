const rabbitmqClient = require('../../../helpers/rabbitmq');
const Logger = require('../../../utils/logger');
const debtorRepository = require('../../debtor/repository/debtor-repository');
const { sqlRequest } = require('../../../helpers/database');
const communityValidator = require('../../../utils/communityValidator');
const TelegramSession = require('../../../utils/telegram-session');

class tasksService {
    /**
     * Відправити завдання на обробку реєстру боржників
     * Чекає на відповідь від Worker (RPC)
     */
    async processDebtorRegister(communityName) {
        // Валідація community_name
        const validation = await communityValidator.validate(communityName);
        if (!validation.isValid) {
            throw new Error(validation.error);
        }

        try {
            Logger.info('Відправка завдання process_debtor_register', {
                communityName
            });

            // Відправляємо завдання та чекаємо на відповідь (60 секунд таймаут)
            const result = await rabbitmqClient.sendTaskWithReply(
                'process_debtor_register',
                { community_name: communityName },
                60000 // 60 секунд
            );

            // Перевіряємо чи успішний результат
            if (!result.success) {
                throw new Error(result.error || 'Помилка обробки на стороні Worker');
            }

            Logger.info('Завдання process_debtor_register виконано', {
                communityName,
                totalRecords: result.total_records
            });

            return result;

        } catch (error) {
            Logger.error('Помилка виконання process_debtor_register', {
                error: error.message,
                communityName
            });
            throw error;
        }
    }

    /**
     * Відправити завдання на відправку email
     * Чекає на відповідь від Worker (RPC)
     */
    async sendEmail(communityName) {
        // Валідація community_name
        const validation = await communityValidator.validate(communityName);
        if (!validation.isValid) {
            throw new Error(validation.error);
        }

        try {
            Logger.info('Відправка завдання send_email', {
                communityName
            });

            // Відправляємо завдання та чекаємо на відповідь (120 секунд таймаут)
            const result = await rabbitmqClient.sendTaskWithReply(
                'send_email',
                { community_name: communityName },
                120000 // 120 секунд для email
            );

            // Перевіряємо чи успішний результат
            if (!result.success) {
                throw new Error(result.error || 'Помилка відправки email на стороні Worker');
            }

            Logger.info('Завдання send_email виконано', {
                communityName,
                recipientEmail: result.recipient_email
            });

            return result;

        } catch (error) {
            Logger.error('Помилка виконання send_email', {
                error: error.message,
                communityName
            });
            throw error;
        }
    }
    /**
     * Виконати оновлення локальної бази даних
     * 1. Запит до віддаленої БД (тип "all")
     * 2. Очистити локальну таблицю ower.ower
     * 3. Завантажити дані у локальну БД
     */
    async updateDatabaseExecute(communityName) {
        // Валідація community_name
        const validation = await communityValidator.validate(communityName);
        if (!validation.isValid) {
            throw new Error(validation.error);
        }

        try {
            Logger.info('Початок оновлення локальної бази даних', {
                communityName
            });

            // Крок 1: Отримати останню дату з віддаленої БД
            Logger.info('Крок 1: Отримання останньої дати');
            const dateResult = await rabbitmqClient.sendTaskWithReply(
                'query_database',
                {
                    community_name: communityName,
                    query_type: 'get_sums'
                },
                30000
            );

            if (!dateResult.success || !dateResult.data || !dateResult.data.latest_date) {
                throw new Error('Не вдалося отримати останню дату з віддаленої БД');
            }

            const latestDate = dateResult.data.latest_date;
            Logger.info('Отримано останню дату', { latestDate });

            // Крок 2: Отримати всі дані за цією датою з віддаленої БД
            Logger.info('Крок 2: Запит даних за датою', { date: latestDate });
            const remoteDataResult = await rabbitmqClient.sendTaskWithReply(
                'query_database',
                {
                    community_name: communityName,
                    query_type: 'all_by_date',
                    date: latestDate
                },
                120000
            );

            if (!remoteDataResult.success) {
                throw new Error(remoteDataResult.error || 'Помилка отримання даних з віддаленої БД');
            }

            if (!remoteDataResult.data || !remoteDataResult.data.records) {
                throw new Error('Немає даних для оновлення');
            }

            const records = remoteDataResult.data.records;
            Logger.info('Отримано записів з віддаленої БД', {
                recordsCount: records.length,
                totalCount: remoteDataResult.data.total_count
            });

            // Крок 3: Очистити локальну таблицю
            Logger.info('Крок 3: Очищення таблиці ower.ower');
            await debtorRepository.flushOwerTable();

            // Крок 4: Завантажити дані
            Logger.info('Крок 4: Масове завантаження даних');
            const insertResult = await debtorRepository.bulkInsertDebtors(records);

            // Крок 5: Імпорт в історію
            Logger.info('Крок 5: Імпорт реєстру в історію');
            let importDate;
            if (records && records.length > 0 && records[0].date) {
                const dateObj = new Date(records[0].date);
                importDate = dateObj.toISOString().split('T')[0];
            } else {
                importDate = new Date().toISOString().split('T')[0];
            }

            Logger.info('Виконання import_registry_to_history', { importDate });
            await sqlRequest('SELECT import_registry_to_history($1)', [importDate]);
            Logger.info('import_registry_to_history виконано успішно');

            // Крок 6: Відправка повідомлень через Telegram Bot API
            Logger.info('Крок 6: Відправка сповіщень користувачам');
            let notifiedCount = 0;
            try {
                const BOT_TOKEN = process.env.BOT_TOKEN;

                if (!BOT_TOKEN) {
                    Logger.warn('BOT_TOKEN не знайдено, пропускаємо відправку повідомлень');
                } else {
                    // Створюємо instance TelegramSession з BOT_TOKEN
                    const telegramSession = new TelegramSession(BOT_TOKEN, sqlRequest, Logger);

                    // Отримуємо дату з відповіді сервера і форматуємо як перше число місяця
                    let formattedDate = importDate;
                    if (records && records.length > 0 && records[0].date) {
                        const dateObj = new Date(records[0].date);
                        // Встановлюємо перше число місяця
                        dateObj.setDate(1);
                        // Форматуємо дату як DD.MM.YYYY
                        const day = String(dateObj.getDate()).padStart(2, '0');
                        const month = String(dateObj.getMonth() + 1).padStart(2, '0');
                        const year = dateObj.getFullYear();
                        formattedDate = `${day}.${month}.${year}`;
                    }

                    // Формуємо текст повідомлення
                    const messageText = `Базу з боржниками успішно оновлено. Інформація станом на: ${formattedDate}`;

                    // Відправляємо повідомлення всім користувачам
                    const notifyResult = await telegramSession.sendToAll(messageText, {
                        parse_mode: "HTML",
                        onProgress: (progress) => {
                            Logger.info('Прогрес відправки сповіщень', {
                                current: progress.current,
                                total: progress.total,
                                percentage: progress.percentage
                            });
                        }
                    });

                    notifiedCount = notifyResult.notifiedCount;

                    Logger.info('Сповіщення відправлено', {
                        notifiedCount: notifyResult.notifiedCount,
                        totalUsers: notifyResult.totalUsers,
                        successRate: notifyResult.successRate,
                        failedCount: notifyResult.failedCount
                    });
                }
            } catch (notifyError) {
                Logger.error('Помилка відправки сповіщень (не критична)', {
                    error: notifyError.message
                });
            }

            Logger.info('Оновлення бази даних завершено успішно', {
                communityName,
                insertedRecords: insertResult.inserted,
                totalSourceRecords: insertResult.totalSourceRecords,
                importDate
            });

            return {
                success: true,
                community_name: communityName,
                remote_total_count: remoteDataResult.data.total_count,
                source_records: insertResult.totalSourceRecords,
                inserted_debtors: insertResult.inserted,
                import_date: importDate,
                notified_users: notifiedCount,
                executed_at: new Date().toISOString()
            };

        } catch (error) {
            Logger.error('Помилка виконання оновлення БД', {
                error: error.message,
                stack: error.stack,
                communityName
            });
            throw error;
        }
    }

    /**
     * Отримати попередній перегляд даних з віддаленої БД
     * Запит типу "get_sums" для отримання статистики
     */
    async previewDatabaseUpdate(communityName) {
        // Валідація community_name
        const validation = await communityValidator.validate(communityName);
        if (!validation.isValid) {
            throw new Error(validation.error);
        }

        try {
            Logger.info('Запит попереднього перегляду оновлення БД', {
                communityName
            });

            // Запит до віддаленої БД для отримання статистики (тип "get_sums")
            const result = await rabbitmqClient.sendTaskWithReply(
                'query_database',
                {
                    community_name: communityName,
                    query_type: 'get_sums'
                },
                30000 // 30 секунд для отримання статистики
            );

            if (!result.success) {
                throw new Error(result.error || 'Помилка отримання даних з віддаленої БД');
            }

            Logger.info('Попередній перегляд отримано успішно', {
                communityName,
                totalDebtors: result.data?.total_debtors
            });

            return result;

        } catch (error) {
            Logger.error('Помилка отримання попереднього перегляду', {
                error: error.message,
                stack: error.stack,
                communityName
            });
            throw error;
        }
    }
}

module.exports = new tasksService();