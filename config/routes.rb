# Роуты плагина Redmine Work Scheme
get '/work_scheme', to: 'work_scheme#show', as: :work_scheme
get '/work_scheme/stages/:id', to: 'work_scheme#stage', as: :work_scheme_stage
